/**
 * What the show-statistics band draws, for the main loop's latest turn.
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
    'show-statistics': { reading: Shaped<Reading> }
  }
}
