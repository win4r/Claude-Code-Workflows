// PR/分支差异审查：扇出→对抗验证→综合报告
// 用例：本地分支准备 push 前自检，或对一个 PR 做独立 second-opinion

export const meta = {
  name: 'review-diff',
  description: 'Review a git diff against a base branch with adversarial verification',
  phases: [
    { title: 'Discover' },
    { title: 'Review' },
    { title: 'Verify' },
    { title: 'Report' },
  ],
}

const { projectRoot, baseRef = 'main' } = args

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

// ---- Phase 1: Discover changed files ----
phase('Discover')

const changes = await agent(
  [
    `Run Bash command: cd ${projectRoot} && git diff --stat ${baseRef}...HEAD`,
    'Then list changed files with additions and deletions.',
    'Skip auto-generated files: package-lock.json, yarn.lock, *.min.js, dist/**, .next/**, build/**',
    'Skip pure-rename moves with 0 line changes.',
    'Return: { files: [{path, additions, deletions}] }',
  ].join('\n'),
  { schema: FILE_LIST_SCHEMA, label: 'discover-files', agentType: 'Explore' }
)

log(`Found ${changes.files.length} changed files to review`)

if (changes.files.length === 0) {
  return { report: 'No reviewable changes against ' + baseRef, stats: { files: 0 } }
}

// ---- Phase 2 & 3: Review each file + verify findings (pipeline) ----
const reviewed = await pipeline(
  changes.files,
  async (file) =>
    agent(
      [
        `You are reviewing changes to ${file.path} (+${file.additions} / -${file.deletions}).`,
        ``,
        `Steps:`,
        `1. Run Bash: cd ${projectRoot} && git diff ${baseRef}...HEAD -- ${file.path}`,
        `2. Read the current full file: Read ${projectRoot}/${file.path}`,
        `3. Identify issues introduced or amplified by THIS diff:`,
        `   - correctness bugs (logic, edge cases, async, error handling)`,
        `   - security concerns (input validation, injection, secrets)`,
        `   - performance regressions (loops, queries, allocations)`,
        `   - missing tests for new behavior`,
        `   - breaking API/contract changes`,
        ``,
        `Cap at 5 findings. Skip nitpicks (formatting, style preference).`,
        `Each finding needs file:line and the actual diff or code snippet.`,
        `Return: { findings: [...], summary }`,
      ].join('\n'),
      { schema: FINDING_SCHEMA, label: `review:${file.path}`, phase: 'Review' }
    ),
  async (review, file) => {
    if (!review || !review.findings || review.findings.length === 0) {
      return { file: file.path, findings: [], summary: review?.summary || 'No issues' }
    }
    const verified = await parallel(
      review.findings.map((f, idx) => async () => {
        const votes = await parallel(
          [0, 1, 2].map((i) => () =>
            agent(
              [
                `Adversarially verify this PR review finding. Default REFUTED.`,
                ``,
                `File: ${projectRoot}/${file.path}`,
                `Finding: ${JSON.stringify(f)}`,
                ``,
                `Steps:`,
                `1. Read ${projectRoot}/${file.path} to verify the cited code exists at the cited line`,
                `2. Run Bash: cd ${projectRoot} && git diff ${baseRef}...HEAD -- ${file.path} to see what actually changed`,
                `3. Decide REAL or REFUTED`,
                ``,
                `REFUTE when: code does not match, issue existed before this diff (not introduced),`,
                `severity inflated, claim is hypothetical.`,
                `CONFIRM when: this diff introduces/amplifies the issue AND realistic impact exists.`,
                ``,
                `Return: { isReal, confidence, reasoning }`,
              ].join('\n'),
              { schema: VERDICT_SCHEMA, label: `verify:${file.path}:${idx}:${i}`, phase: 'Verify' }
            )
          )
        )
        const real = votes.filter(Boolean).filter((v) => v.isReal).length
        return { ...f, file: file.path, confirmed: real >= 2 }
      })
    )
    return { file: file.path, findings: verified.filter(Boolean), summary: review.summary }
  }
)

// ---- Phase 4: Synthesize report ----
phase('Report')

const allFindings = reviewed.filter(Boolean).flatMap((r) => r.findings || [])
const confirmed = allFindings.filter((f) => f.confirmed)
const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 }
confirmed.sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9))

const sevCounts = { critical: 0, high: 0, medium: 0, low: 0 }
for (const f of confirmed) sevCounts[f.severity]++

const verdict =
  sevCounts.critical > 0 ? 'BLOCK' :
  sevCounts.high > 0 ? 'FIX-FIRST' :
  'SHIP'

log(`Verdict: ${verdict} (${sevCounts.critical}C/${sevCounts.high}H/${sevCounts.medium}M/${sevCounts.low}L)`)

const report = await agent(
  [
    `Write a PR review summary in Chinese Markdown.`,
    ``,
    `Stats:`,
    `- Files reviewed: ${changes.files.length}`,
    `- Raw findings: ${allFindings.length}`,
    `- Confirmed (>=2/3 votes): ${confirmed.length}`,
    `- Severity: critical=${sevCounts.critical}, high=${sevCounts.high}, medium=${sevCounts.medium}, low=${sevCounts.low}`,
    `- Suggested verdict: ${verdict}`,
    ``,
    `Confirmed findings:`,
    JSON.stringify(confirmed, null, 2),
    ``,
    `Structure:`,
    `## 一、TL;DR`,
    `1 段话：改动范围 + 风险评估 + verdict 建议`,
    ``,
    `## 二、严重度分布`,
    ``,
    `## 三、关键发现 (Critical + High)`,
    `每条含：标题、文件:行、问题描述、代码片段、修复建议`,
    ``,
    `## 四、其他发现 (Medium + Low)`,
    `每条一句话`,
    ``,
    `## 五、未发现问题的文件`,
    `列出 review 后无 confirmed finding 的文件`,
    ``,
    `约束：精确、证据驱动、不要 general advice。`,
  ].join('\n'),
  { label: 'synthesize-report', phase: 'Report' }
)

return {
  report,
  verdict,
  stats: {
    files: changes.files.length,
    raw_findings: allFindings.length,
    confirmed: confirmed.length,
    severity: sevCounts,
  },
  confirmedFindings: confirmed,
}
