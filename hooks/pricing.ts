/**
 * What one model is billed at, in US dollars per million tokens.
 */
export type Rates = {
  /** Uncached input tokens. */
  input: number
  /** Output tokens, thinking included. */
  output: number
  /** Input tokens the prompt cache served. */
  cacheRead: number
  /** Input tokens written to the prompt cache (both cache lifetimes). */
  cacheWrite: number
}

/**
 * What `pricing.json` holds: a rate row per model, a fallback row, and a
 * multiplier over everything.
 *
 * With no rate row at all, only `multiplier` applies, scaling the engine's
 * `/cost` ledger instead of pricing the responses here.
 */
export type Pricing = {
  /** Multiplies every dollar figure; 1 when the file does not say. */
  multiplier: number
  /** Rate rows by model id. */
  models: Record<string, Rates>
  /** The row a model no key matches is priced at. */
  fallback?: Rates
}

/** The token counts of a response's usage, as a rate row prices them. */
export type UsageCounts = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function parseRates(raw: unknown): Rates | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const row = raw as Record<string, unknown>
  const { input, output, cacheRead, cacheWrite } = row

  if (!isRate(input) || !isRate(output) || !isRate(cacheRead) || !isRate(cacheWrite)) {
    return null
  }

  return { input, output, cacheRead, cacheWrite }
}

/**
 * Reads the file's value: a malformed object gives null, and a malformed rate
 * row is left out, so one typo costs that model only.
 */
export function parsePricing(raw: unknown): Pricing | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const file = raw as Record<string, unknown>
  const multiplier = typeof file.multiplier === 'number'
    && Number.isFinite(file.multiplier)
    && file.multiplier > 0
    ? file.multiplier
    : 1

  const models: Record<string, Rates> = {}
  const table = file.models

  if (table !== null && typeof table === 'object' && !Array.isArray(table)) {
    for (const [model, row] of Object.entries(table)) {
      const rates = parseRates(row)

      if (rates !== null) {
        models[model] = rates
      }
    }
  }

  const fallback = parseRates(file.fallback) ?? undefined

  return { multiplier, models, fallback }
}

/** Whether the file prices responses itself, rather than scaling the ledger. */
export function hasRates(pricing: Pricing): boolean {
  return Object.keys(pricing.models).length > 0 || pricing.fallback !== undefined
}

/**
 * The row a model id is priced at: an exact key first (case aside), then the
 * longest key the id contains (`sonnet` of `claude-sonnet-5-5-20260101`), then
 * the fallback; null when nothing matches.
 */
export function ratesFor(pricing: Pricing, model: string): Rates | null {
  const id = model.toLowerCase()
  const exact = Object.keys(pricing.models).find(name => name.toLowerCase() === id)

  if (exact !== undefined) {
    return pricing.models[exact] ?? null
  }

  let best: string | undefined

  for (const name of Object.keys(pricing.models)) {
    const part = name.toLowerCase()

    if (id.includes(part) && (best === undefined || part.length > best.length)) {
      best = name
    }
  }

  if (best !== undefined) {
    return pricing.models[best] ?? null
  }

  return pricing.fallback ?? null
}

/** What a response cost: its four counts at the row's rates, times the multiplier. */
export function costOf(rates: Rates, usage: UsageCounts, multiplier: number): number {
  const perMillion = usage.input_tokens * rates.input
    + usage.output_tokens * rates.output
    + usage.cache_read_input_tokens * rates.cacheRead
    + usage.cache_creation_input_tokens * rates.cacheWrite

  return (perMillion / 1_000_000) * multiplier
}
