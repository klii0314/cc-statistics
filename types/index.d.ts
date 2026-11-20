/**
 * What the cc-statistics band draws, for the main loop's latest turn.
 *
 * A reload of the module meets the values an earlier version stored, so the
 * `reading` atom carries a shape tag: bump it whenever this contract changes.
 */
export type Reading = {
  /** Milliseconds from the request leaving to the first streamed token. */
  ttftMs: number | null
  /** Output tokens per second over the latest step's stream. */
  tps: number | null
  /** US dollars this session has cost so far, every model call included. */
  sessionUsd: number | null
  /** US dollars the latest turn has cost so far. */
  turnUsd: number | null
  /** True while a model response of the turn is streaming. */
  isStreaming: boolean
  /** Tokens this session has moved, as the API reported them. */
  tokens: Tokens
  /**
   * How the two costs were priced: `ledger` is the engine's `/cost`, `custom`
   * is the plugin's own rates from `pricing.json` (or its multiplier).
   */
  pricedBy: 'ledger' | 'custom'
  /** US dollars the plugin has priced itself this session (custom rates only). */
  customUsd: number
  /**
   * The newer version the band offers, when one is installed but not taken;
   * null when the installed copy is the one on disk.
   */
  updateVersion: string | null
  /** Which of the six readings the row draws. */
  fields: Fields
  /** True while the menu of readings is open under the row. */
  isMenuOpen: boolean
  /**
   * The rates set from the menu, US dollars per million tokens; null until one
   * is typed, when the engine's ledger (or pricing.json) prices the costs.
   */
  rates: Rates | null
}

/** US dollars per million tokens, the four a response is billed at. */
export type Rates = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Which readings the row shows; the menu on the left toggles them. */
export type Fields = {
  ttft: boolean
  tps: boolean
  tokens: boolean
  cache: boolean
  turn: boolean
  session: boolean
}

/**
 * The session's token counts, added up by the mod from each response's usage:
 * every main-loop request, and each subagent's turn when it ended.
 */
export type Tokens = {
  /** Prompt tokens sent: uncached, cache-written and cache-read together. */
  input: number
  /** Of those `input` tokens, the ones the prompt cache served. */
  cached: number
  /** Tokens the model generated. */
  output: number
}

declare module 'claude-code' {
  interface PluginState {
    'cc-statistics': { reading: Shaped<Reading> }
  }
}
