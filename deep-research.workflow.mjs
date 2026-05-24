// 深度研究：多角度并行搜索 → barrier 去重 → 逐条 verbatim quote 验证 → 综合报告
// 用例：技术选型、领域调研、防止跨 LLM 共享幻觉

export const meta = {
  name: 'deep-research',
  description: 'Multi-source research with verbatim quote verification',
  phases: [
    { title: 'Search' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
}

const { question, targetLang = 'Chinese' } = args

const ANGLES = [
  { name: 'docs', desc: 'Official documentation, vendor product pages, RFC, specification documents' },
  { name: 'papers', desc: 'Academic papers, arXiv preprints, technical writeups by researchers' },
  { name: 'community', desc: 'GitHub issues, Stack Overflow accepted answers, Reddit threads with high upvotes' },
  { name: 'practitioners', desc: 'Engineering blogs from companies actually using the technology in production' },
]

const CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          statement: { type: 'string' },
          verbatim_quote: { type: 'string' },
          source_url: { type: 'string' },
          source_title: { type: 'string' },
          claim_type: { type: 'string', enum: ['number', 'behavior', 'api', 'date', 'benchmark', 'comparison'] },
        },
        required: ['statement', 'verbatim_quote', 'source_url', 'source_title', 'claim_type'],
      },
    },
    angle: { type: 'string' },
    searches_run: { type: 'array', items: { type: 'string' } },
  },
  required: ['claims', 'angle', 'searches_run'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    quote_found: { type: 'boolean' },
    context_supports: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string' },
  },
  required: ['quote_found', 'context_supports', 'confidence', 'reasoning'],
}

function dedupeByQuote(claims) {
  const seen = new Set()
  return claims.filter((c) => {
    const key = c.verbatim_quote.toLowerCase().replace(/\s+/g, ' ').slice(0, 80)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---- Phase 1: Search across 4 angles (barrier needed for dedup) ----
phase('Search')
log(`Searching "${question}" across ${ANGLES.length} angles...`)

const searches = await parallel(
  ANGLES.map((a) => () =>
    agent(
      [
        `Research question: ${question}`,
        ``,
        `Your assigned angle: ${a.desc}`,
        `Stay in this angle — do not look at other source types.`,
        ``,
        `Tools: WebSearch + WebFetch.`,
        ``,
        `Steps:`,
        `1. Run 3-5 targeted searches matching your angle`,
        `2. Fetch top 5 most relevant URLs (skip paywalled, dead, 404)`,
        `3. Extract concrete claims: numbers, dates, behaviors, API signatures, benchmark results`,
        `4. Each claim needs a VERBATIM QUOTE (10-30 words copied exactly from source) and source URL`,
        `5. Skip vague claims like "it's faster" — only concrete ones with measurable evidence`,
        `6. Cap at 8 claims`,
        ``,
        `Return: { claims: [...], angle: '${a.name}', searches_run: [...] }`,
      ].join('\n'),
      { schema: CLAIM_SCHEMA, label: `search:${a.name}` }
    )
  )
)

// Barrier here: must dedup across all angles before expensive verification
const allClaims = searches
  .filter(Boolean)
  .flatMap((s) => s.claims.map((c) => ({ ...c, angle: s.angle })))

const dedupedClaims = dedupeByQuote(allClaims)

log(`${allClaims.length} raw claims -> ${dedupedClaims.length} unique after dedup`)

if (dedupedClaims.length === 0) {
  return { report: `No concrete claims found for: ${question}`, stats: { angles: ANGLES.length } }
}

// ---- Phase 2: Verify each claim against its cited source ----
phase('Verify')

const verified = await parallel(
  dedupedClaims.map((claim, idx) => async () => {
    const verdict = await agent(
      [
        `Verify this claim against its cited source. Default to NOT supporting the claim.`,
        ``,
        `Claim: "${claim.statement}"`,
        `Cited verbatim quote: "${claim.verbatim_quote}"`,
        `Source URL: ${claim.source_url}`,
        ``,
        `Steps:`,
        `1. WebFetch ${claim.source_url} and wait for full content`,
        `2. Search for the verbatim quote (allow minor whitespace and punctuation differences, NOT paraphrase)`,
        `3. If found, read surrounding 200 words and check whether that context supports the claim's interpretation`,
        ``,
        `quote_found = true means the EXACT or near-exact text appears in the page.`,
        `context_supports = true means the surrounding text actually backs up the paraphrase the claim makes.`,
        ``,
        `Common failure: quote is fabricated by upstream LLM (shared hallucination across multiple models).`,
        `Another common failure: quote exists but is taken out of context.`,
        ``,
        `Return: { quote_found, context_supports, confidence, reasoning }`,
      ].join('\n'),
      { schema: VERDICT_SCHEMA, label: `verify:${idx}` }
    )
    return {
      ...claim,
      verdict,
      confirmed: !!verdict?.quote_found && !!verdict?.context_supports,
    }
  })
)

const validVerified = verified.filter(Boolean)
const confirmed = validVerified.filter((c) => c.confirmed)
const refuted = validVerified.filter((c) => !c.confirmed)

log(`Verified: ${confirmed.length} confirmed, ${refuted.length} refuted (likely shared hallucinations)`)

// ---- Phase 3: Synthesize report ----
phase('Synthesize')

const report = await agent(
  [
    `Write a research report on: ${question}`,
    ``,
    `Confirmed claims (each verbatim-verified against source):`,
    JSON.stringify(confirmed, null, 2),
    ``,
    `Refuted: ${refuted.length} (likely fabricated quotes or out-of-context misuse)`,
    `Angles covered: ${ANGLES.map((a) => a.name).join(', ')}`,
    ``,
    `Structure:`,
    `1. Executive Summary (3-5 sentences, ONLY verified claims)`,
    `2. Key findings grouped by sub-topic, each cites [n]`,
    `3. Numbered source list with URL`,
    `4. Open questions where evidence was thin`,
    `5. Notable source disagreements (if any), present both sides`,
    ``,
    `Constraints:`,
    `- No claim without [n] citation`,
    `- Do not add inference beyond what sources support`,
    `- When sources disagree, present both — do not pick a winner unless one is clearly wrong`,
    `- Write in ${targetLang}`,
  ].join('\n'),
  { label: 'synthesize-report' }
)

return {
  report,
  stats: {
    angles: ANGLES.length,
    raw_claims: allClaims.length,
    unique_claims: dedupedClaims.length,
    confirmed: confirmed.length,
    refuted: refuted.length,
  },
  confirmedClaims: confirmed,
}
