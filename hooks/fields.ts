import type { Fields } from '../types'

/** Every reading shown: the value a session starts with. */
export const ALL_FIELDS: Fields = {
  ttft: true,
  tps: true,
  tokens: true,
  cache: true,
  turn: true,
  session: true,
}

/** Whether two selections show the same readings. */
export function sameFields(a: Fields, b: Fields): boolean {
  return a.ttft === b.ttft
    && a.tps === b.tps
    && a.tokens === b.tokens
    && a.cache === b.cache
    && a.turn === b.turn
    && a.session === b.session
}

/**
 * What one session saved for the others: the six flags, or null when the value
 * is not one (a store an older build wrote, a hand-edited file).
 */
export function readFields(raw: unknown): Fields | null {
  if (raw === null || typeof raw !== 'object') {
    return null
  }

  const saved = raw as Record<string, unknown>
  const fields: Fields = { ...ALL_FIELDS }

  for (const name of ['ttft', 'tps', 'tokens', 'cache', 'turn', 'session'] as const) {
    const flag = saved[name]

    if (typeof flag !== 'boolean') {
      return null
    }

    fields[name] = flag
  }

  return fields
}
