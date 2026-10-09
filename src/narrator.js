/**
 * The report narrator — the smallest Qwen model writing one paragraph.
 *
 * A generated report's sections are deterministic: the same store computes the
 * same figures twice. What the sections are not is readable prose, and the one
 * text a report needs beyond its figures is a short paragraph a coordinator can
 * lift into a briefing. This module produces it with the smallest Qwen model
 * served locally (Ollama, keyless, default `qwen3:0.6b` — 0.6B parameters), and
 * it is built around one rule:
 *
 * **A generated sentence must not generate a fact.**
 *
 * The model sees the report's own computed figures and nothing else. Its
 * output is checked by code before it is published:
 *
 *   - every digit figure it writes must be among the figures it was given;
 *     a text that introduces an unlisted number is REFUSED, with the invented
 *     figure named — not truncated, not "cleaned", not published;
 *   - an empty reply, a reply beyond the agreed length, a transport failure
 *     and an HTTP error are each refusals carrying their own reason;
 *   - generation runs at temperature 0.
 *
 * A refused narration is a fine outcome: the report still carries its computed
 * sections, and the refusal is recorded on the report where an approver reads
 * it. The narrator is explicitly opt-in (`LINDELA_LITE_NARRATOR=1`); off is
 * the default, because a deployment that cannot reach a model server owes no
 * explanation for refusing quietly.
 */

/**
 * The model basis, in the same voice as MODEL_BASIS in src/flood-probability.js:
 * what wrote the text, what it may do, what it must never do, and how it fails.
 */
export const NARRATOR_BASIS = Object.freeze({
  basis: 'Qwen — the smallest shipped variant, default qwen3:0.6b (0.6B parameters), served locally via Ollama /api/generate, temperature 0',
  serves: 'one commentary paragraph of at most ~120 words for a generated report, built only from the figures the report\'s own deterministic sections computed',
  not: 'the narrative is not a source of figures or of actions: every number in the text is checked against the facts it was given, a text that introduces an unlisted figure is refused, and the refusal is recorded where an approver reads it',
  refusals: 'narrator not configured · model server unreachable · HTTP error · empty reply · invented figure · reply beyond the agreed length',
  checked: 'the count of digit figures the model restated ships with the text (numbers_checked), so a reader can see the text was audited, not trusted',
  language: 'plain English; a report distributed in another locale still ships the English commentary until a locale-tuned narrator is wired',
})

export const NARRATOR_MODEL_DEFAULT = 'qwen3:0.6b'
export const NARRATOR_BASE_URL_DEFAULT = 'http://127.0.0.1:11434'
export const NARRATOR_MAX_CHARS = 1200

/**
 * The narrator's configuration. Off until an operator switches it on — the
 * same explicit opt-in as `LINDELA_LITE_TRUST_PROXY=1` — because a model
 * server that is merely present is not a narrator a deployment asked for.
 *
 * `override` is createServer's injection point: a caller that built the server
 * with a narrator option names the endpoint explicitly rather than through env
 * (the pattern `options.inboundLimiter` set, and which a test needs to reach a
 * per-test model server on an ephemeral port).
 */
export function narratorStatus(env = process.env, override = null) {
  const source = override || {}
  const enabled = source.enabled ?? String(env.LINDELA_LITE_NARRATOR || '') === '1'
  const timeoutMs = Number(source.timeoutMs ?? env.LINDELA_LITE_NARRATOR_TIMEOUT_MS ?? 20000)
  return {
    enabled,
    base_url: String(source.baseUrl || env.OLLAMA_BASE_URL || '') || NARRATOR_BASE_URL_DEFAULT,
    model: String(source.model || env.LINDELA_LITE_NARRATOR_MODEL || '') || NARRATOR_MODEL_DEFAULT,
    timeout_ms: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000,
  }
}

function extractFigures(text) {
  return String(text || '').match(/\d+(?:\.\d+)?/g) || []
}

/**
 * The digest: the facts, as the report's own sections computed them.
 *
 * Deliberately the sections' rendered content and not the store's records —
 * the sections are already auditable objects with source refs, and a narrator
 * that reached past them into the store would be inventing a second,
 * unaudited reading path. Allowed figures are extracted from the title, scope
 * and digest only — never from the prompt's instructions (which name limits
 * like "120 words" that must not become facts the model is free to restate).
 */
export function buildNarrativeRequest(report, { maxWords = 120 } = {}) {
  const scopeString = Object.entries(report.scope || {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'all records'
  const digestParts = []
  for (const section of report.sections || []) {
    digestParts.push(`${section.title}: ${String(section.content?.summary || '').trim()}`)
    for (const [key, value] of Object.entries(section.content?.metrics || {})) {
      digestParts.push(`- ${key.replaceAll('_', ' ')}: ${formatValue(value)}`)
    }
    for (const item of (section.content?.items || []).slice(0, 5)) {
      digestParts.push(`- ${Object.entries(item).map(([k, v]) => `${k}: ${v}`).join(' | ')}`)
    }
  }
  const digest = digestParts.join('\n')
  const title = String(report.title || '')
  const allowedFacts = `${title}\n${scopeString}\n${digest}`
  return {
    title,
    digest,
    allowedNumbers: new Set(extractFigures(allowedFacts)),
    system: [
      'You write one short paragraph of commentary for a humanitarian situation report.',
      'Rules you must not break:',
      `- Use ONLY the figures listed under FACTS. Restating one is allowed (${maxWords} words is your maximum).`,
      '- Introduce no new number, no new name, no advice, no speculation.',
      '- Plain English. No markup, no headings, no bullet lists.',
    ].join('\n'),
    prompt: [
      `REPORT: ${title} (${report.report_type || 'report'}, scope: ${scopeString})`,
      'FACTS, as the report\'s own computed sections state them:',
      digest,
      'Write the commentary paragraph.',
    ].join('\n'),
  }
}

function formatValue(value) {
  return typeof value === 'number' ? String(value) : String(value ?? '')
}

/**
 * Ask the model for the paragraph, then audit the answer.
 *
 * `http` is the transport (undici's fetch by default); an injected transport
 * exists so a unit test can shape replies without a socket, while the route
 * test below runs the REAL transport against a real Ollama-shaped server —
 * no mocks.
 *
 * Never throws for model/transport problems: a refusal is data, returned.
 */
export async function narrateReport(report, {
  env = process.env, narrator = null, http: transport = fetch, now = new Date().toISOString(),
} = {}) {
  const config = narratorStatus(env, narrator)
  const model = config.model
  const refused = (reason) => ({ status: 'refused', reason, model, text: null, generated_at: now })

  if (!config.enabled) {
    return refused('narrator not configured — set LINDELA_LITE_NARRATOR=1 (and OLLAMA_BASE_URL for a remote model server)')
  }
  if (!(report?.sections || []).length) {
    return refused('the report has no generated sections to narrate; generate it first')
  }

  const request = buildNarrativeRequest(report)
  let answer
  try {
    const res = await transport(`${config.base_url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        prompt: request.prompt,
        system: request.system,
        stream: false,
        // Thinking-capable Qwens burn the token budget on the reasoning
        // channel and leave `response` empty; commentary is a restatement, so
        // thinking is explicitly off. A model or Ollama build that ignores
        // this field keeps working; one that cannot turn it off is refused
        // below with the reason named, not answered with blank text.
        think: false,
        // Temperature 0: the commentary is a restatement. A sampled paragraph
        // twice for the same report should be the same paragraph.
        options: { temperature: 0, num_predict: 512 },
      }),
      signal: AbortSignal.timeout(config.timeout_ms),
    })
    if (!res.ok) return refused(`the model server answered HTTP ${res.status} for ${model}`)
    const payload = await res.json()
    answer = payload?.response
    if (!answer && payload?.thinking) {
      return refused(`the model (${model}) spent its reply in the thinking channel and wrote no commentary; serve it with thinking disabled (Ollama: think=false)`)
    }
  } catch (error) {
    return refused(`the model server could not be reached: ${error.message}`)
  }

  const text = String(answer || '').trim()
  if (!text) return refused(`the model (${model}) returned an empty reply`)
  if (text.length > NARRATOR_MAX_CHARS) {
    return refused(`the model (${model}) wrote beyond the agreed length (${text.length} > ${NARRATOR_MAX_CHARS} characters); nothing is truncated into a partial claim`)
  }

  // The figure audit. Word-form numbers ("four", "dozens") are prose, not
  // figures; a digit token is a claim, and an unlisted one is an invention.
  const found = extractFigures(text).map((token) => token.replace(/,/g, ''))
  const invented = found.filter((token) => !request.allowedNumbers.has(token))
  if (invented.length) {
    return refused(`the model (${model}) introduced a figure the facts do not state: ${[...new Set(invented)].join(', ')}`)
  }

  return {
    status: 'narrated',
    text,
    model,
    numbers_checked: found.length,
    generated_at: now,
    basis: NARRATOR_BASIS,
  }
}