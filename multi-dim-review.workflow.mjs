export const meta = {
  name: 'multi-dim-review-memory-lancedb-pro',
  description: 'Comprehensive multi-dimensional code review of memory-lancedb-pro (TypeScript MCP plugin)',
  phases: [
    { title: 'Discovery', detail: 'Map codebase structure and entry points' },
    { title: 'Review', detail: 'Parallel review across 9 dimensions' },
    { title: 'Verify', detail: 'Adversarial 3-vote verification per finding' },
    { title: 'Synthesize', detail: 'Aggregate into prioritized report' },
  ],
}

const ROOT = '/Users/charlesqin/Downloads/memory-lancedb-pro-master'

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
          file: { type: 'string' },
          line: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['title', 'severity', 'file', 'line', 'description', 'evidence', 'recommendation'],
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

phase('Discovery')
const discoveryPrompt = [
  'Map the codebase at ' + ROOT + ' for an upcoming multi-dimensional code review.',
  '',
  'This is a TypeScript MCP plugin called memory-lancedb-pro that provides long-term memory for OpenClaw AI agents using LanceDB.',
  '',
  'Produce a concise structured report (under 2000 words) covering:',
  '',
  '1. Project Purpose: 2 sentences from README about what this delivers.',
  '2. Entry Points: cli.ts and index.ts roles, MCP server entry point.',
  '3. Directory Layout: top-level dirs (src, test, docs, scripts, skills, examples) with one-line purpose each.',
  '4. Source Modules: For each file in src/ (~45 files), one-line purpose. Group related modules under headings (e.g., Retrieval, Storage, Extraction, Governance, Reflection).',
  '5. MCP Tools Surface: list the public MCP tools exposed from src/tools.ts with one-line description each.',
  '6. External Dependencies: from package.json — list key deps (lancedb, @modelcontextprotocol/sdk, ollama, etc.) with purpose.',
  '7. Test Layout: test categories (unit / e2e / integration) and rough counts; note any obvious untested src files.',
  '8. Build/Config: tsconfig.json target, package.json scripts.',
  '9. Hot Files: 12 most important files for a reviewer to examine (by centrality, size, or risk).',
  '',
  'Use absolute paths under ' + ROOT + '. Be precise — reviewers will Read these files directly.',
].join('\n')

const map = await agent(discoveryPrompt, { label: 'codebase-map', agentType: 'Explore' })

const DIMENSIONS = [
  {
    key: 'correctness',
    title: 'Correctness',
    focus: 'logic errors; edge cases (empty inputs, unicode/CJK, very large data, concurrent calls, zero-result branches); off-by-one errors; race conditions in async code; intent-vs-implementation mismatches; broken invariants; incorrect handling of LanceDB result shapes; error swallow vs propagate mismatches',
  },
  {
    key: 'security',
    title: 'Security',
    focus: 'input validation gaps on MCP tool boundary; prompt-injection vectors in stored memories that re-enter LLM prompts; query injection in LanceDB filter strings (where filters are built by string concatenation); secrets/API keys leaking into logs or default configs; path traversal in any file ops; arbitrary code execution risks (eval, dynamic require); workspace/scope isolation bypass; OAuth token handling in llm-oauth.ts',
  },
  {
    key: 'performance',
    title: 'Performance',
    focus: 'O(N^2) loops, unbounded growth (caches, queues, in-memory stores); N+1 queries against LanceDB; redundant embedding calls; missing or wrong indexes; synchronous I/O in async hot paths; large payloads serialized in MCP tool responses; missing pagination; chunker/decay/compaction efficiency',
  },
  {
    key: 'reliability',
    title: 'Reliability',
    focus: 'missing retries on transient embedder/LLM failures; missing timeouts on network calls; unhandled promise rejections; resource leaks (DB connections, file handles); partial-state failures during bulk operations; idempotency gaps in store/upsert; MCP tool error reporting quality and exit-on-error vs degrade gracefully; auto-capture-cleanup safety',
  },
  {
    key: 'maintainability',
    title: 'Maintainability',
    focus: 'premature abstractions; unnecessary indirection; dead code; dead config flags; coupling between unrelated modules; misleading naming; oversized functions/files; duplicated logic across modules (e.g., similar logic in retriever / adaptive-retrieval / auto-recall-tier1); magic numbers without named constants',
  },
  {
    key: 'testing',
    title: 'Testing',
    focus: 'test coverage gaps for critical src/ files (especially store.ts, retriever.ts, smart-extractor.ts, tools.ts); weak assertions (only checks truthy / non-null); brittle implementation-coupled tests; missing edge cases (empty / oversized / concurrent); missing async error-path tests; missing tests against real LanceDB integration vs mocked',
  },
  {
    key: 'architecture',
    title: 'Architecture',
    focus: 'design pattern misuse; module boundary violations; layering violations (e.g., low-level modules importing high-level); circular dependencies; MCP tool surface coherence (consistent param naming, response shape, error format); configurability vs hardcoded behavior; scope/responsibility creep; tier-manager and decay-engine separation of concerns',
  },
  {
    key: 'data-integrity',
    title: 'Data Integrity',
    focus: 'LanceDB schema correctness and migration safety in migrate.ts; transaction-like guarantees in bulk-store and batch-dedup; data validation before persistence; embedding dimension consistency; soft-delete vs hard-delete semantics; multi-scope (clawteam-scope, scopes.ts) isolation correctness; potential data corruption from concurrent writers; identity-addressing collisions',
  },
  {
    key: 'typescript-idiomatic',
    title: 'TypeScript Idiomatic',
    focus: 'overuse of any/unknown; missing strict null checks; lost type narrowing; sync/async API design inconsistencies; promise patterns (parallel vs sequential where wrong); error class design vs string errors; module export hygiene; tsconfig strict mode adoption; explicit return types on public surface',
  },
]

function buildReviewPrompt(d, mapText) {
  return [
    'You are a senior code reviewer specializing in ' + d.title + '.',
    '',
    'Project: memory-lancedb-pro — TypeScript MCP plugin providing long-term memory for OpenClaw AI agents via LanceDB.',
    'Project root: ' + ROOT,
    '',
    'Project map (from discovery phase):',
    mapText,
    '',
    'Your mission: Review the codebase for ' + d.title.toUpperCase() + ' issues.',
    'Focus areas: ' + d.focus,
    '',
    'Approach:',
    '1. Pick 6-10 highest-priority files to read based on the map and your focus',
    '2. Use the Read tool with absolute paths under ' + ROOT + ' to inspect them',
    '3. Use Grep to find specific patterns when useful',
    '4. For each finding, gather concrete evidence (file path, line range, actual code snippet)',
    '5. Only report findings backed by code you actually read — no hypotheticals',
    '6. Skip nitpicks — report what would matter on a serious PR review or production audit',
    '7. Cap at 8 findings — prioritize the strongest',
    '',
    'For each finding return:',
    '- title: short summary under 80 chars',
    '- severity: critical | high | medium | low (be honest, do not inflate)',
    '- file: absolute path',
    '- line: line number or range (e.g., "42" or "42-58"); empty string if not file-specific',
    '- description: what is wrong, in 2-3 sentences',
    '- evidence: actual code snippet from the file (5-15 lines, preserve formatting)',
    '- recommendation: how to fix, in 1-2 sentences',
    '',
    'If no significant issues, return findings: [] with a one-paragraph summary explaining what you checked and why it looks healthy.',
  ].join('\n')
}

function buildVerifyPrompt(d, f) {
  return [
    'You are an adversarial code review verifier. Default to REFUTED unless evidence is clear and the bug is real under realistic conditions.',
    '',
    'Project root: ' + ROOT,
    '',
    'Claim under review (dimension: ' + d.title + '):',
    '- Title: ' + f.title,
    '- Severity: ' + f.severity,
    '- File: ' + f.file,
    '- Line: ' + (f.line || 'N/A'),
    '- Description: ' + f.description,
    '- Evidence claimed:',
    f.evidence,
    '- Recommendation: ' + f.recommendation,
    '',
    'Task:',
    '1. Read the file at ' + f.file + ' using the Read tool to verify the claim against actual code',
    '2. Check whether the cited evidence accurately reflects current code at the cited lines',
    '3. Determine if the issue is REAL (true) or REFUTED (false)',
    '',
    'Reasons to REFUTE (return isReal=false):',
    '- Code does not match the cited evidence (line moved, fixed, or never existed)',
    '- Behavior is correct under closer inspection (e.g., guard upstream, framework handles it)',
    '- Severity is overstated (e.g., critical claim that is actually low impact)',
    '- Claim is hypothetical with no concrete trigger path',
    '- Recommendation would not actually fix the problem',
    '',
    'Reasons to CONFIRM (return isReal=true):',
    '- Code matches evidence AND would cause a real bug, regression, or risk under realistic conditions',
    '- Severity is reasonable given impact and likelihood',
    '',
    'Return:',
    '- isReal: true if the finding holds up; false if refuted',
    '- confidence: high | medium | low — your confidence in the verdict',
    '- reasoning: 2-3 sentences explaining the verdict with evidence from the file you actually read',
  ].join('\n')
}

phase('Review')
const reviewed = await pipeline(
  DIMENSIONS,
  async (d) => agent(buildReviewPrompt(d, map), { label: 'review:' + d.key, phase: 'Review', schema: FINDING_SCHEMA }),
  async (review, d) => {
    if (!review || !review.findings || review.findings.length === 0) {
      return { dimension: d.key, title: d.title, findings: [], summary: (review && review.summary) || 'No findings' }
    }
    const verified = await parallel(
      review.findings.map((f, idx) => async () => {
        const votes = await parallel(
          [0, 1, 2].map((i) => () =>
            agent(buildVerifyPrompt(d, f), {
              label: 'verify:' + d.key + ':' + idx + ':' + i,
              phase: 'Verify',
              schema: VERDICT_SCHEMA,
            })
          )
        )
        const validVotes = votes.filter(Boolean)
        const realVotes = validVotes.filter((v) => v.isReal).length
        return {
          ...f,
          dimension: d.key,
          dimensionTitle: d.title,
          verdict: { realVotes, totalVotes: validVotes.length, votes: validVotes },
          confirmed: realVotes >= 2,
        }
      })
    )
    return {
      dimension: d.key,
      title: d.title,
      findings: verified.filter(Boolean),
      summary: review.summary,
    }
  }
)

phase('Synthesize')
const allFindings = reviewed.filter(Boolean).flatMap((r) => r.findings || [])
const confirmed = allFindings.filter((f) => f.confirmed)
const refuted = allFindings.filter((f) => !f.confirmed)

const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 }
confirmed.sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9))

const sevCounts = { critical: 0, high: 0, medium: 0, low: 0 }
for (const f of confirmed) sevCounts[f.severity] = (sevCounts[f.severity] || 0) + 1

log(
  'Reviewed ' +
    DIMENSIONS.length +
    ' dimensions. Raw findings: ' +
    allFindings.length +
    '. Confirmed (>=2/3): ' +
    confirmed.length +
    '. Refuted: ' +
    refuted.length +
    '. Sev: c=' +
    sevCounts.critical +
    ' h=' +
    sevCounts.high +
    ' m=' +
    sevCounts.medium +
    ' l=' +
    sevCounts.low +
    '.'
)

const perDimSummary = reviewed
  .filter(Boolean)
  .map((r) => {
    const conf = r.findings.filter((x) => x.confirmed).length
    return '- ' + r.title + ' (' + conf + '/' + r.findings.length + ' confirmed): ' + r.summary
  })
  .join('\n')

const refutedList = refuted
  .map((f) => '- [' + f.dimensionTitle + '] ' + f.title + ' (claimed ' + f.severity + ')')
  .join('\n')

const synthPrompt = [
  'You are writing the final multi-dimensional code review report for the memory-lancedb-pro project.',
  '',
  'Project root: ' + ROOT,
  'Dimensions reviewed: ' + DIMENSIONS.map((d) => d.title).join(', '),
  'Raw findings: ' + allFindings.length,
  'Confirmed by adversarial vote (>=2/3): ' + confirmed.length,
  'Refuted: ' + refuted.length,
  'Severity counts (confirmed): critical=' +
    sevCounts.critical +
    ', high=' +
    sevCounts.high +
    ', medium=' +
    sevCounts.medium +
    ', low=' +
    sevCounts.low,
  '',
  'Confirmed findings (sorted by severity then dimension):',
  JSON.stringify(confirmed, null, 2),
  '',
  'Per-dimension summaries from reviewers:',
  perDimSummary,
  '',
  'Refuted findings (titles only, for context on what was filtered out):',
  refutedList,
  '',
  'Write the report in CHINESE (the user communicates in Chinese). Use the following structure precisely:',
  '',
  '# memory-lancedb-pro 多维度代码审查报告',
  '',
  '## 一、Executive Summary',
  '3-5 句话：项目状态、最关键的发现、总体风险评估、建议下一步。',
  '',
  '## 二、严重度分布（确认后）',
  '- Critical: N',
  '- High: N',
  '- Medium: N',
  '- Low: N',
  '- 驳回（对抗验证不通过）: ' + refuted.length,
  '',
  '## 三、关键发现（Critical + High）',
  '列出所有 critical 和 high 级别的确认发现。每条用以下格式：',
  '',
  '### [严重度] 标题',
  '- 维度: ...',
  '- 文件: `path:line`',
  '- 问题: 2-3 句描述',
  '- 证据: 用 typescript 代码块',
  '- 修复: 1-2 句建议',
  '',
  '## 四、按维度分组（Medium + Low）',
  '为每个维度列出 medium 和 low 级别的确认发现（标题 + 文件:行 + 一句话描述）。如果某维度没有 medium/low 发现，写"无重大发现"。',
  '',
  '## 五、跨切面模式',
  '找出 2-4 个跨越多个维度的共性问题或反模式。每条 2-3 句，引用支持它的发现。',
  '',
  '## 六、优先修复行动计划',
  '按优先级排序的具体修复任务列表，每个任务标注：',
  '- 工作量预估（S = <1天, M = 1-3天, L = >3天）',
  '- 涉及的文件',
  '- 解锁价值（修了之后能带来什么）',
  '',
  '## 七、被驳回发现的说明',
  '列出被对抗验证驳回的发现数（' + refuted.length + '），并给出 1-3 个典型驳回原因（每个一句话）。整段不超过 200 字。',
  '',
  '约束：',
  '- 精确、证据驱动、可执行',
  '- 不要任何 "general advice" 段落',
  '- Markdown 格式',
  '- 代码片段必须保留原始格式',
  '- 如果 confirmed.length === 0，依然产出完整结构，第三、四节注明"无确认发现"，并把重点放在第五、六节的预防性建议',
].join('\n')

const report = await agent(synthPrompt, { label: 'final-report', phase: 'Synthesize' })

return {
  report,
  stats: {
    dimensions: DIMENSIONS.length,
    rawFindings: allFindings.length,
    confirmed: confirmed.length,
    refuted: refuted.length,
    severityCounts: sevCounts,
  },
  confirmedFindings: confirmed,
}
