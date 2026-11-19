import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Reading, Tokens } from '../types'
import { costOf, hasRates, parsePricing, ratesFor } from './pricing'
import type { Pricing } from './pricing'

const NO_TOKENS: Tokens = { input: 0, cached: 0, output: 0 }

const EMPTY: Reading = {
  ttftMs: null,
  tps: null,
  sessionUsd: null,
  turnUsd: null,
  isStreaming: false,
  tokens: NO_TOKENS,
  pricedBy: 'ledger',
  customUsd: 0,
}

// The band's one value: a write redraws the row the hook read it in.
const reading = atom(
  { plugin: 'show-cost', key: 'reading' } as const,
  EMPTY,
  { shape: 'reading-3' },
)

// How often the row refreshes while a response streams (in chunks, so no
// clock read rides along with every piece), and the rough characters a token
// spans for the live estimate that the stop chunk's count replaces.
const LIVE_EVERY = 32
const CHARS_PER_TOKEN = 4

// Columns the whole row takes; narrower, the costs move to a second line.
const WIDE_COLUMNS = 88

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`
}

function rate(tps: number): string {
  return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1)
}

function dollars(usd: number): string {
  if (usd === 0) {
    return '$0.00'
  }

  return usd < 0.1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

function count(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`
  }

  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  }

  return `${n}`
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(2)}%` : '—'
}

function turnCost(sessionUsd: number | null, turnStartUsd: number | null): number | null {
  if (sessionUsd === null || turnStartUsd === null) {
    return null
  }

  return Math.max(0, sessionUsd - turnStartUsd)
}

// One response's counts, added to what the session had moved so far.
function withUsage(tokens: Tokens, usage: ModelUsage): Tokens {
  return {
    input: tokens.input
      + usage.input_tokens
      + usage.cache_read_input_tokens
      + usage.cache_creation_input_tokens,
    cached: tokens.cached + usage.cache_read_input_tokens,
    output: tokens.output + usage.output_tokens,
  }
}

// The plugin's own rates, when the person wrote them beside it. Read again at
// every turn's start, so an edit lands on the next turn with no reload.
async function loadPricing($: EngineInterface): Promise<Pricing | null> {
  const path = `${$.plugin.root}/pricing.json`

  try {
    if (!(await $.fs.exists(path))) {
      return null
    }

    return parsePricing(JSON.parse(await $.fs.read(path)))
  } catch {
    return null
  }
}

export const register: Register = on => {
  // The session's total when the main loop's current turn began; the module's
  // own, so a reload starts the turn's cost afresh.
  let turnStartUsd: number | null = null
  let pricing: Pricing | null = null
  const warned = new Set<string>()

  // `$` may be spelled only at the call site, so the helper answers the line
  // and the hook logs it.
  const unpricedNote = (model: string): string | null => {
    if (warned.has(model)) {
      return null
    }

    warned.add(model)

    return `show-cost: no pricing row matches ${model}; its tokens are priced at $0`
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    turnStartUsd = usage.cost?.usd ?? null
    await update($, reading, () => ({ ...EMPTY, sessionUsd: turnStartUsd }))

    return result
  })

  // A /clear (or a resume taking the process) starts a fresh session with no
  // `session.start`: what the row showed belonged to the one that ended.
  on('session.end', async ($, e, next) => {
    const result = await next(e)

    if (e.reason === 'clear' || e.reason === 'resume') {
      turnStartUsd = null
      await update($, reading, () => ({ ...EMPTY }))
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined) {
      return result
    }

    pricing = await loadPricing($)
    const active = pricing

    if (active !== null && hasRates(active)) {
      // The plugin prices the turn's responses itself, so the row counts from
      // what it has priced, not from the engine's ledger.
      turnStartUsd = null
      await update($, reading, row => ({
        ...row,
        ttftMs: null,
        tps: null,
        sessionUsd: row.customUsd,
        turnUsd: 0,
        // The turn's first request is about to leave: the row waits, not dashes.
        isStreaming: true,
        pricedBy: 'custom' as const,
      }))

      return result
    }

    const usage = await $.session.usage()
    const pricedBy: Reading['pricedBy'] = active !== null && active.multiplier !== 1 ? 'custom' : 'ledger'
    turnStartUsd = usage.cost?.usd ?? null
    await update($, reading, row => ({
      ...row,
      ttftMs: null,
      tps: null,
      sessionUsd: turnStartUsd ?? row.sessionUsd,
      turnUsd: null,
      isStreaming: true,
      pricedBy,
    }))

    return result
  })

  // A main-loop request, watched as it streams: the first output chunk dates
  // the time to first token, the stop chunk carries the tokens and the cost.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e)
    }

    const sentAt = await $.clock.now()
    let firstAt: number | null = null
    let chars = 0
    let chunks = 0
    let settled = false

    const stream = next(e)
    for await (const chunk of stream) {
      const isOutput = chunk.kind === 'text'
        || chunk.kind === 'thinking'
        || chunk.kind === 'tool'
        || chunk.kind === 'input'

      if (chunk.kind === 'text' || chunk.kind === 'thinking') {
        chars += chunk.text.length
      } else if (chunk.kind === 'input') {
        chars += chunk.json.length
      }

      if (isOutput) {
        chunks += 1

        if (firstAt === null) {
          firstAt = await $.clock.now()
          const ttftMs = firstAt - sentAt
          await update($, reading, row => ({ ...row, ttftMs, isStreaming: true }))
        } else if (chunks % LIVE_EVERY === 0) {
          // A live estimate: characters over the stream's elapsed time, which
          // the stop chunk's counted tokens replace.
          const elapsedMs = (await $.clock.now()) - firstAt

          if (elapsedMs >= 400) {
            const tps = chars / CHARS_PER_TOKEN / (elapsedMs / 1000)
            await update($, reading, row => ({ ...row, tps, isStreaming: true }))
          }
        }
      }

      if (chunk.kind === 'stop') {
        const stoppedAt = await $.clock.now()
        const usage = chunk.usage
        const outputTokens = usage?.output_tokens ?? null
        const windowMs = stoppedAt - (firstAt ?? sentAt)
        const tps = outputTokens !== null && windowMs > 0
          ? outputTokens / (windowMs / 1000)
          : null
        const ttftMs = firstAt === null ? null : firstAt - sentAt
        const active = pricing

        if (active !== null && hasRates(active)) {
          // Priced here at the person's own rates.
          const rates = usage === null ? null : ratesFor(active, usage.model)
          const note = usage !== null && rates === null ? unpricedNote(usage.model) : null

          if (note !== null) {
            $.ui.log(note)
          }

          const delta = usage !== null && rates !== null
            ? costOf(rates, usage, active.multiplier)
            : 0

          await update($, reading, row => ({
            ...row,
            ttftMs: row.ttftMs ?? ttftMs,
            tps,
            isStreaming: false,
            tokens: usage === null ? row.tokens : withUsage(row.tokens, usage),
            customUsd: row.customUsd + delta,
            sessionUsd: row.customUsd + delta,
            turnUsd: (row.turnUsd ?? 0) + delta,
            pricedBy: 'custom' as const,
          }))
        } else {
          // The engine's ledger, scaled when the file names a multiplier.
          const session = await $.session.usage()
          const engineUsd = session.cost?.usd ?? null
          const multiplier = active !== null ? active.multiplier : 1
          const sessionUsd = engineUsd !== null ? engineUsd * multiplier : null
          const delta = turnCost(engineUsd, turnStartUsd)
          const turnUsd = delta !== null ? delta * multiplier : null

          await update($, reading, row => ({
            ...row,
            ttftMs: row.ttftMs ?? ttftMs,
            tps,
            isStreaming: false,
            tokens: usage === null ? row.tokens : withUsage(row.tokens, usage),
            sessionUsd: sessionUsd ?? row.sessionUsd,
            turnUsd,
            pricedBy: (multiplier !== 1 ? 'custom' : 'ledger') as Reading['pricedBy'],
          }))
        }

        settled = true
      }

      yield chunk
    }

    const result = await stream.result

    if (!settled) {
      await update($, reading, row => ({
        ...row,
        ttftMs: firstAt === null ? row.ttftMs : firstAt - sentAt,
        isStreaming: false,
      }))
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const active = pricing

    // A subagent's own requests are not watched as steps here, so its summed
    // usage is added whole; the main loop's steps already counted themselves.
    if (e.agentId !== undefined) {
      const usage = e.usage

      if (usage !== undefined) {
        if (active !== null && hasRates(active)) {
          const rates = ratesFor(active, usage.model)
          const note = rates === null ? unpricedNote(usage.model) : null

          if (note !== null) {
            $.ui.log(note)
          }

          const delta = rates === null ? 0 : costOf(rates, usage, active.multiplier)
          await update($, reading, row => ({
            ...row,
            tokens: withUsage(row.tokens, usage),
            customUsd: row.customUsd + delta,
            sessionUsd: row.customUsd + delta,
            turnUsd: (row.turnUsd ?? 0) + delta,
            pricedBy: 'custom' as const,
          }))
        } else {
          await update($, reading, row => ({ ...row, tokens: withUsage(row.tokens, usage) }))
        }
      }

      return result
    }

    // Each response priced itself above: the ledger is not the source then.
    if (active !== null && hasRates(active)) {
      return result
    }

    const session = await $.session.usage()
    const engineUsd = session.cost?.usd ?? null
    const multiplier = active !== null ? active.multiplier : 1
    const sessionUsd = engineUsd !== null ? engineUsd * multiplier : null
    const delta = turnCost(engineUsd, turnStartUsd)
    const turnUsd = delta !== null ? delta * multiplier : null

    await update($, reading, row => ({
      ...row,
      sessionUsd: sessionUsd ?? row.sessionUsd,
      turnUsd,
      isStreaming: false,
      pricedBy: (multiplier !== 1 ? 'custom' : 'ledger') as Reading['pricedBy'],
    }))

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const row = await read($, reading)
    const { Box, Text } = $.ui.resolve(e)
    const ttft = row.ttftMs !== null ? seconds(row.ttftMs) : row.isStreaming ? '…' : '—'
    const tps = row.tps !== null
      ? `${rate(row.tps)} token/s`
      : row.isStreaming ? '…' : '—'
    const moved = row.tokens.input + row.tokens.output
    const tokens = moved > 0 ? count(moved) : '—'
    const cache = percent(row.tokens.cached, row.tokens.input)
    const mark = row.pricedBy === 'custom' ? '*' : ''
    const turn = row.turnUsd !== null ? `${dollars(row.turnUsd)}${mark}` : '—'
    const session = row.sessionUsd !== null ? `${dollars(row.sessionUsd)}${mark}` : '—'

    // The Texts sit straight in the Box: a fragment would be laid out as a
    // column on the desktop surface, so each one is a sibling here.
    if (e.props.bodyColumns >= WIDE_COLUMNS) {
      return (
        <Box>
          <Text dimColor>TTFT </Text>
          <Text color="claude">{ttft}</Text>
          <Text dimColor>  TPS </Text>
          <Text color="claude">{tps}</Text>
          <Text dimColor>  tokens </Text>
          <Text color="claude">{tokens}</Text>
          <Text dimColor>  cache </Text>
          <Text color="suggestion">{cache}</Text>
          <Text dimColor>  turn </Text>
          <Text color="warning">{turn}</Text>
          <Text dimColor>  session </Text>
          <Text color="success">{session}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>TTFT </Text>
          <Text color="claude">{ttft}</Text>
          <Text dimColor>  TPS </Text>
          <Text color="claude">{tps}</Text>
          <Text dimColor>  tokens </Text>
          <Text color="claude">{tokens}</Text>
          <Text dimColor>  cache </Text>
          <Text color="suggestion">{cache}</Text>
        </Box>
        <Box>
          <Text dimColor>turn </Text>
          <Text color="warning">{turn}</Text>
          <Text dimColor>  session </Text>
          <Text color="success">{session}</Text>
        </Box>
      </Box>
    )
  })
}
