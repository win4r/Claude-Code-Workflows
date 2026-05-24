// 跨模型代码审查：Claude + Codex 独立审查，互相 verify
// 用例：高风险变更需要双模型独立证据；防止单模型的"自洽幻觉"

export const meta = {
  name: 'cross-model-review',
  description: 'Code review with independent Claude + Codex reviewers and mutual cross-verification',
  phases: [
    { title: 'Precheck' },
    { title: 'Discover' },
    { title: 'Review' },
    { title: 'Cross-verify' },
    { title: 'Report' },
  ],
}

const { projectRoot, baseRef = 'main', codexCmd = 'codex' } = args

const FILE_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          additions: { type: 'number' },
          deletions: { type: 'number' },
        },
        required: ['path', 'additions', 'deletions'],
      },
    },
  },
  required: ['files'],
}

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          line: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['title', 'severity', 'line', 'description', 'evidence', 'recommendation'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['findings', 'summary'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    isReal: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string' },
  },
  required: ['isReal', 'confidence', 'reasoning'],
}

const PRECHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    available: { type: 'boolean' },
    version: { type: 'string' },
    authenticated: { type: 'boolean' },
    exec_syntax: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['available', 'version', 'authenticated', 'exec_syntax', 'notes'],
}

// ---- Helpers (in-script, no fs access needed) ----
function parseLineRange(s) {
  if (!s) return [0, 0]
  const m = String(s).match(/(\d+)(?:\s*[-–]\s*(\d+))?/)
  if (!m) return [0, 0]
  const start = parseInt(m[1], 10)
  const end = m[2] ? parseInt(m[2], 10) : start
  return [start, end]
}

function findingsOverlap(a, b) {
  if (a.file !== b.file) return false
  const [aStart, aEnd] = parseLineRange(a.line)
  const [bStart, bEnd] = parseLineRange(b.line)
  if (aStart === 0 && bStart === 0) {
    return a.title.toLowerCase().slice(0, 30) === b.title.toLowerCase().slice(0, 30)
  }
  return aStart <= bEnd + 5 && bStart <= aEnd + 5
}

function classifyFindings(all) {
  const result = []
  for (const f of all) {
    const counterpart = all.find(
      (other) => other !== f && other.source !== f.source && findingsOverlap(f, other)
    )
    result.push({ ...f, hasCounterpart: !!counterpart, counterpartTitle: counterpart?.title })
  }
  return result
}

// ---- Phase 1: Precheck codex availability ----
phase('Precheck')

const precheck = await agent(
  [
    `Check whether the codex CLI is installed and ready to use.`,
    ``,
    `Steps using Bash tool:`,
    `1. Try: ${codexCmd} --version`,
    `2. Try: which ${codexCmd}`,
    `3. Try: ${codexCmd} --help | head -50 — to learn the exec/non-interactive syntax`,
    `4. Identify the right syntax for non-interactive invocation:`,
    `   - Try: ${codexCmd} exec "Hello" or ${codexCmd} "Hello"`,
    `   - Check for --json flag, -p flag, stdin support`,
    `5. If codex is authenticated, the test prompt will return quickly.`,
    `   If it asks to log in, set authenticated=false and notes='Run: codex login'`,
    ``,
    `Return:`,
    `- available: true if codex command resolves`,
    `- version: version string from --version`,
    `- authenticated: true if a simple test prompt succeeds`,
    `- exec_syntax: the exact command pattern that works for non-interactive use`,
    `  (e.g., "codex exec --json \"PROMPT\"" or "codex \"PROMPT\"")`,
    `- notes: any caveats, error messages, or setup steps needed`,
  ].join('\n'),
  { schema: PRECHECK_SCHEMA, label: 'codex-precheck' }
)

if (!precheck?.available || !precheck?.authenticated) {
  log(`Codex precheck failed: ${precheck?.notes || 'unknown'}`)
  return {
    error: 'codex-unavailable',
    precheck,
    hint: 'Install codex CLI and run `codex login`, then retry. See https://github.com/openai/codex',
  }
}

const codexExec = precheck.exec_syntax
log(`Codex ready: ${precheck.version}. Exec syntax: ${codexExec}`)

// ---- Phase 2: Discover changed files ----
phase('Discover')

const changes = await agent(
  [
    `Run Bash: cd ${projectRoot} && git diff --stat ${baseRef}...HEAD`,
    `List changed files with additions/deletions.`,
    `Skip auto-generated: package-lock.json, yarn.lock, *.min.js, dist/**, build/**`,
    `Return: { files: [{path, additions, deletions}] }`,
  ].join('\n'),
  { schema: FILE_LIST_SCHEMA, label: 'discover-files', agentType: 'Explore' }
)

log(`Found ${changes.files.length} changed files`)

if (changes.files.length === 0) {
  return { report: 'No reviewable changes', stats: { files: 0 } }
}

// ---- Phase 3 & 4: Parallel reviews (Claude + Codex), then cross-verify ----
const reviewed = await pipeline(
  changes.files,

  // Stage 1: Parallel review by Claude and Codex on the same file
  async (file) => {
    const [claudeReview, codexReview] = await parallel([
      () =>
        agent(
          [
            `You are Claude, reviewing changes to ${file.path}.`,
            ``,
            `Steps:`,
            `1. Run Bash: cd ${projectRoot} && git diff ${baseRef}...HEAD -- ${file.path}`,
            `2. Read: ${projectRoot}/${file.path}`,
            `3. Identify issues introduced by this diff: correctness, security, performance, missing tests, breaking changes`,
            `4. Cap at 5 findings. Skip nitpicks.`,
            `Each finding needs file:line and code snippet.`,
            ``,
            `Return: { findings: [...], summary }`,
          ].join('\n'),
          { schema: FINDING_SCHEMA, label: `claude:${file.path}`, phase: 'Review' }
        ),
      () =>
        agent(
          [
            `Invoke codex CLI for an independent review of ${file.path}.`,
            ``,
            `Confirmed codex exec syntax (from precheck): ${codexExec}`,
            ``,
            `Steps using Bash tool:`,
            `1. Get the diff: cd ${projectRoot} && git diff ${baseRef}...HEAD -- ${file.path} > /tmp/diff-${file.path.replace(/\\//g, '_')}.txt`,
            `2. Get the current file: cat ${projectRoot}/${file.path} > /tmp/file-${file.path.replace(/\\//g, '_')}.txt`,
            `3. Build a review prompt for codex. Example shape:`,
            ``,
            `   Review this code change in ${file.path}. Find bugs introduced by this diff: correctness,`,
            `   security, performance, missing tests. For each finding give:`,
            `   - line number`,
            `   - severity (critical/high/medium/low)`,
            `   - one-sentence description`,
            `   - actual code snippet showing the problem`,
            `   - recommended fix`,
            `   Cap at 5 findings. Skip style nitpicks.`,
            ``,
            `   <DIFF>`,
            `   <paste contents of /tmp/diff-...txt>`,
            `   </DIFF>`,
            ``,
            `   <FULL_FILE>`,
            `   <paste contents of /tmp/file-...txt>`,
            `   </FULL_FILE>`,
            ``,
            `4. Pipe that prompt to codex using the confirmed exec syntax. Capture stdout.`,
            `5. Parse codex's output into the FINDING_SCHEMA structure:`,
            `   - codex may output markdown, plain text, or JSON depending on flags`,
            `   - extract each finding with its line, severity, description, evidence, recommendation`,
            `   - if codex output has no findings, return findings: []`,
            ``,
            `If codex invocation fails or times out (>2 min), return findings: [] and explain in summary.`,
            ``,
            `Return: { findings: [...], summary }`,
          ].join('\n'),
          { schema: FINDING_SCHEMA, label: `codex:${file.path}`, phase: 'Review' }
        ),
    ])

    const claudeFindings = ((claudeReview && claudeReview.findings) || []).map((f) => ({
      ...f,
      source: 'claude',
      file: file.path,
    }))
    const codexFindings = ((codexReview && codexReview.findings) || []).map((f) => ({
      ...f,
      source: 'codex',
      file: file.path,
    }))

    return { file, claudeFindings, codexFindings, claudeSummary: claudeReview?.summary, codexSummary: codexReview?.summary }
  },

  // Stage 2: Cross-verify each finding using the OPPOSITE model
  async ({ file, claudeFindings, codexFindings, claudeSummary, codexSummary }) => {
    const allFindings = [...claudeFindings, ...codexFindings]
    if (allFindings.length === 0) {
      return { file: file.path, findings: [], claudeSummary, codexSummary }
    }

    const crossVerified = await parallel(
      allFindings.map((f, idx) => async () => {
        let verdict
        if (f.source === 'claude') {
          // Codex verifies a Claude finding
          verdict = await agent(
            [
              `Use codex CLI to independently verify a code review finding from another reviewer.`,
              `Default REFUTED unless codex agrees the finding is real.`,
              ``,
              `Confirmed codex exec syntax: ${codexExec}`,
              ``,
              `The finding to verify:`,
              JSON.stringify(f, null, 2),
              ``,
              `Steps using Bash tool:`,
              `1. cat ${projectRoot}/${f.file} to load the actual current code`,
              `2. Build a verify prompt for codex:`,
              ``,
              `   Another reviewer claims this is a bug in ${f.file} at line ${f.line}:`,
              `   Title: ${f.title}`,
              `   Description: ${f.description}`,
              `   Evidence: <quote the claimed evidence>`,
              ``,
              `   Look at the actual file. Is this a REAL bug that would cause problems`,
              `   in production, or is the reviewer wrong?`,
              ``,
              `   Answer with: VERDICT (REAL|REFUTED), CONFIDENCE (high|medium|low), REASONING (2-3 sentences).`,
              ``,
              `   <ACTUAL_FILE>`,
              `   <paste file contents>`,
              `   </ACTUAL_FILE>`,
              ``,
              `3. Run that through codex. Capture stdout.`,
              `4. Parse codex's verdict into { isReal, confidence, reasoning }.`,
              ``,
              `If codex says REAL → isReal: true. If REFUTED → isReal: false.`,
              `If codex's output is ambiguous, default to isReal: false (we default REFUTED).`,
            ].join('\n'),
            { schema: VERDICT_SCHEMA, label: `codex-verifies:${file.path}:${idx}`, phase: 'Cross-verify' }
          )
        } else {
          // Claude verifies a Codex finding
          verdict = await agent(
            [
              `You are Claude, independently verifying a code review finding produced by codex.`,
              `Default REFUTED unless you can confirm the bug is real.`,
              ``,
              `Codex's finding:`,
              JSON.stringify(f, null, 2),
              ``,
              `Steps:`,
              `1. Read ${projectRoot}/${f.file} fully`,
              `2. Check if the cited evidence at line ${f.line} actually matches the current code`,
              `3. Check if the issue is real and triggerable, not hypothetical`,
              ``,
              `REFUTE when: code does not match evidence, issue is pre-existing (not from this diff),`,
              `severity inflated, behavior is actually correct, recommendation would not fix it.`,
              `CONFIRM when: code matches AND realistic trigger exists AND impact is real.`,
              ``,
              `Return: { isReal, confidence, reasoning }`,
            ].join('\n'),
            { schema: VERDICT_SCHEMA, label: `claude-verifies:${file.path}:${idx}`, phase: 'Cross-verify' }
          )
        }

        const verifier = f.source === 'claude' ? 'codex' : 'claude'
        return {
          ...f,
          crossVerifierUsed: verifier,
          crossVerified: !!verdict?.isReal,
          crossConfidence: verdict?.confidence || 'low',
          crossReasoning: verdict?.reasoning || '',
        }
      })
    )

    return {
      file: file.path,
      findings: crossVerified.filter(Boolean),
      claudeSummary,
      codexSummary,
    }
  }
)

// ---- Phase 5: Match findings across models, classify by agreement, synthesize report ----
phase('Report')

const allFindings = reviewed.filter(Boolean).flatMap((r) => r.findings || [])
const classified = classifyFindings(allFindings)

// Tier 1: HIGH confidence — both models found independently (regardless of cross-verify)
const bothFound = classified.filter((f) => f.hasCounterpart)
// Deduplicate (each pair counted once, keep the claude version as canonical)
const seenPairs = new Set()
const highConfidence = []
for (const f of bothFound) {
  const pairKey = [f.file, parseLineRange(f.line)[0]].join(':')
  if (!seenPairs.has(pairKey)) {
    seenPairs.add(pairKey)
    highConfidence.push(f)
  }
}

// Tier 2: MEDIUM confidence — only one model found AND the other model cross-verified it
const mediumConfidence = classified.filter((f) => !f.hasCounterpart && f.crossVerified)

// Tier 3: DISPUTED — only one model found AND the other refuted
const disputed = classified.filter((f) => !f.hasCounterpart && !f.crossVerified)

const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 }
const allConfirmed = [...highConfidence, ...mediumConfidence]
allConfirmed.sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9))

const sevCounts = { critical: 0, high: 0, medium: 0, low: 0 }
for (const f of allConfirmed) sevCounts[f.severity]++

const verdict =
  sevCounts.critical > 0 ? 'BLOCK' :
  sevCounts.high > 0 ? 'FIX-FIRST' :
  'SHIP'

log(
  `Findings: high-confidence=${highConfidence.length}, ` +
  `medium=${mediumConfidence.length}, disputed=${disputed.length}. Verdict: ${verdict}`
)

const report = await agent(
  [
    `Write a cross-model code review report in Chinese Markdown.`,
    ``,
    `Stats:`,
    `- Files reviewed: ${changes.files.length}`,
    `- Total raw findings: ${allFindings.length}`,
    `- HIGH confidence (both models found independently): ${highConfidence.length}`,
    `- MEDIUM confidence (one found, other cross-verified): ${mediumConfidence.length}`,
    `- DISPUTED (one found, other refuted — needs human judgment): ${disputed.length}`,
    `- Severity (confirmed): critical=${sevCounts.critical}, high=${sevCounts.high}, medium=${sevCounts.medium}, low=${sevCounts.low}`,
    `- Verdict: ${verdict}`,
    ``,
    `HIGH confidence findings (both models independently identified):`,
    JSON.stringify(highConfidence, null, 2),
    ``,
    `MEDIUM confidence findings (single-model + cross-verified):`,
    JSON.stringify(mediumConfidence, null, 2),
    ``,
    `DISPUTED findings (single-model + other refuted):`,
    JSON.stringify(disputed, null, 2),
    ``,
    `Structure:`,
    `## 一、TL;DR`,
    `1 段话总览：verdict、置信度分布、最关键的几个发现`,
    ``,
    `## 二、置信度分布`,
    `表格：HIGH / MEDIUM / DISPUTED 数量与含义`,
    ``,
    `## 三、HIGH 置信度发现（两模型独立发现）`,
    `每条含：标题、文件:行、问题描述、两个模型各自的证据片段、修复建议`,
    `这些是最值得优先修复的`,
    ``,
    `## 四、MEDIUM 置信度发现（单模型发现 + 跨模型验证通过）`,
    `每条含：标题、来源模型、验证模型、问题、修复`,
    ``,
    `## 五、DISPUTED 区（需要人类裁决）`,
    `这是最重要的人类参与点：一个模型说有问题、另一个说没问题`,
    `每条含：标题、claim 模型的论据、反驳模型的论据、建议的人类判断点`,
    ``,
    `## 六、为什么使用跨模型审查`,
    `1 段话：HIGH 区代表两模型独立到达的共识；DISPUTED 区暴露单模型可能的幻觉或盲区`,
    ``,
    `约束：精确、证据驱动、不要 general advice。`,
  ].join('\n'),
  { label: 'synthesize-report' }
)

return {
  report,
  verdict,
  stats: {
    files: changes.files.length,
    raw_findings: allFindings.length,
    high_confidence: highConfidence.length,
    medium_confidence: mediumConfidence.length,
    disputed: disputed.length,
    severity: sevCounts,
  },
  highConfidence,
  mediumConfidence,
  disputed,
}
