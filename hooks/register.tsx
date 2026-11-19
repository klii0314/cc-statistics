import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Reading, Tokens } from '../types'
import { costOf, hasRates, parsePricing, ratesFor } from './pricing'
import type { Pricing } from './pricing'
import { isNewer, pluginJsonUrl, repoOf } from './versions'

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
  updateVersion: null,
}

// The band's one value: a write redraws the row the hook read it in.
const reading = atom(
  { plugin: 'cc-statistics', key: 'reading' } as const,
  EMPTY,
  { shape: 'reading-4' },
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
    return `${(n / 1_000_000).toFixed(2)}M`
  }

  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(2)}k`
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

// ---- the update button's check -------------------------------------------
// The CLI knows what is installed and, for the folder a folder-install reads,
// what version sits there: `folderVersion` newer than `version` is a version
// waiting to be taken. The check runs behind a draw, throttled, and never per
// piece of the stream.
const CHECK_EVERY_MS = 5 * 60_000
let lastCheckAt = 0
let isChecking = false

// The directory holding known_marketplaces.json, found by climbing out of the
// installed copy (`.../.claude/plugins/cache/<market>/<plugin>/<version>`).
async function pluginsDirectory($: EngineInterface): Promise<string | null> {
  const sep = $.plugin.root.includes('\\') ? '\\' : '/'
  let dir = $.plugin.root

  for (let i = 0; i < 6; i += 1) {
    const cut = dir.lastIndexOf(sep)

    if (cut <= 0) {
      return null
    }

    dir = dir.slice(0, cut)

    if (await $.fs.exists(`${dir}${sep}known_marketplaces.json`)) {
      return dir
    }
  }

  return null
}

// A marketplace install keeps no copy of the folder the version would come
// from, so the repository recorded for its marketplace is asked directly.
async function remoteVersion(
  $: EngineInterface,
  marketplace: string,
  installed: string,
): Promise<string | null> {
  const dir = await pluginsDirectory($)

  if (dir === null) {
    return null
  }

  const sep = dir.includes('\\') ? '\\' : '/'
  const known: unknown = JSON.parse(await $.fs.read(`${dir}${sep}known_marketplaces.json`))

  if (known === null || typeof known !== 'object') {
    return null
  }

  const entry = (known as Record<string, unknown>)[marketplace]
  const source = entry !== null && typeof entry === 'object'
    ? (entry as { source?: unknown }).source
    : null
  const repo = repoOf(source)

  if (repo === null) {
    return null
  }

  const response = await $.http.fetch(pluginJsonUrl(repo))

  if (!response.ok) {
    return null
  }

  const remote: unknown = JSON.parse(response.text)

  if (remote === null || typeof remote !== 'object') {
    return null
  }

  const version = (remote as { version?: unknown }).version

  return typeof version === 'string' && isNewer(version, installed) ? version : null
}

async function newerVersion($: EngineInterface): Promise<string | null> {
  const result = await $.process.run(
    ['claude', 'plugin', 'list', '--json'],
    { timeoutMs: 30_000 },
  )

  if (result.exitCode !== 0) {
    return null
  }

  const rows: unknown = JSON.parse(result.stdout)

  if (!Array.isArray(rows)) {
    return null
  }

  const prefix = `${$.plugin.name}@`

  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') {
      continue
    }

    const row = raw as { id?: unknown; version?: unknown; folderVersion?: unknown }

    if (typeof row.id !== 'string' || !row.id.startsWith(prefix)) {
      continue
    }

    const installed = typeof row.version === 'string' ? row.version : null
    const onDisk = typeof row.folderVersion === 'string' ? row.folderVersion : null

    if (installed === null) {
      return null
    }

    if (onDisk !== null) {
      return onDisk !== installed ? onDisk : null
    }

    return await remoteVersion($, row.id.slice(prefix.length), installed)
  }

  return null
}

async function checkUpdate($: EngineInterface): Promise<void> {
  if (isChecking || Date.now() - lastCheckAt < CHECK_EVERY_MS) {
    return
  }

  isChecking = true
  lastCheckAt = Date.now()

  try {
    const latest = await newerVersion($)
    await update($, reading, row => (row.updateVersion === latest ? row : { ...row, updateVersion: latest }))
  } catch {
    // A check that cannot run leaves the last answer.
  } finally {
    isChecking = false
  }
}

// ---- what outlives a session ---------------------------------------------
// `$.state` belongs to the session, so a resumed or restarted session starts
// empty. The accumulator is mirrored into `$.store` under the session's id:
// a reload, a respawn and a resume keep the id and read it back, a new chat
// has a new id and starts at zero.
let storeKey: string | null | undefined

async function accumulatorKey($: EngineInterface): Promise<string | null> {
  if (storeKey !== undefined) {
    return storeKey
  }

  try {
    storeKey = `reading:${await $.session.id()}`
  } catch {
    storeKey = null
  }

  return storeKey
}

async function persistReading($: EngineInterface, value: Reading): Promise<void> {
  const key = await accumulatorKey($)

  if (key === null) {
    return
  }

  try {
    await $.store.set(key, { tokens: value.tokens, customUsd: value.customUsd })
  } catch {
    // A refused write costs the next restart, never the row on screen.
  }
}

async function restoreReading($: EngineInterface): Promise<void> {
  const key = await accumulatorKey($)

  if (key === null) {
    return
  }

  try {
    const saved = await $.store.get(key)

    if (saved === null || typeof saved !== 'object') {
      return
    }

    const record = saved as { tokens?: unknown; customUsd?: unknown }
    const counts = record.tokens

    if (counts === null || typeof counts !== 'object') {
      return
    }

    const token = counts as { input?: unknown; cached?: unknown; output?: unknown }

    if (typeof token.input !== 'number'
      || typeof token.cached !== 'number'
      || typeof token.output !== 'number') {
      return
    }

    const tokens: Tokens = { input: token.input, cached: token.cached, output: token.output }
    const customUsd = typeof record.customUsd === 'number' ? record.customUsd : 0

    await update($, reading, row => (
      row.tokens.input + row.tokens.output > 0
        ? row
        : { ...row, tokens, customUsd }
    ))
  } catch {
    // Nothing saved, or a store that cannot be read: the session starts fresh.
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

    return `cc-statistics: no pricing row matches ${model}; its tokens are priced at $0`
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    turnStartUsd = usage.cost?.usd ?? null
    // The plugin starts again on a reload and on a worker respawn, both inside
    // the same session: keep what the row already counted instead of zeroing
    // it, or every reload reads as a reset.
    await restoreReading($)
    await update($, reading, row => ({
      ...row,
      sessionUsd: usage.cost?.usd ?? row.sessionUsd,
    }))
    // Ask behind the turn, not inside it: the answer lands in the row.
    void checkUpdate($)

    return result
  })

  // A /clear (or a resume taking the process) starts a fresh session with no
  // `session.start`: what the row showed belonged to the one that ended.
  on('session.end', async ($, e, next) => {
    const result = await next(e)

    if (e.reason === 'clear' || e.reason === 'resume') {
      // A /clear starts over for good: the stored total goes with it. A resume
      // keeps the store, and the session that takes over reads it back.
      if (e.reason === 'clear') {
        const key = await accumulatorKey($)

        if (key !== null) {
          try {
            await $.store.delete(key)
          } catch {
            // Nothing stored, or a store that refuses: the row still clears.
          }
        }
      }

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

    // Throttled: at most one CLI call every few minutes, never per draw.
    void checkUpdate($)
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

          const written = await update($, reading, row => ({
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
          void persistReading($, written)
        } else {
          // The engine's ledger, scaled when the file names a multiplier.
          const session = await $.session.usage()
          const engineUsd = session.cost?.usd ?? null
          const multiplier = active !== null ? active.multiplier : 1
          const sessionUsd = engineUsd !== null ? engineUsd * multiplier : null
          const delta = turnCost(engineUsd, turnStartUsd)
          const turnUsd = delta !== null ? delta * multiplier : null

          const written = await update($, reading, row => ({
            ...row,
            ttftMs: row.ttftMs ?? ttftMs,
            tps,
            isStreaming: false,
            tokens: usage === null ? row.tokens : withUsage(row.tokens, usage),
            sessionUsd: sessionUsd ?? row.sessionUsd,
            turnUsd,
            pricedBy: (multiplier !== 1 ? 'custom' : 'ledger') as Reading['pricedBy'],
          }))
          void persistReading($, written)
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
          const written = await update($, reading, row => ({
            ...row,
            tokens: withUsage(row.tokens, usage),
            customUsd: row.customUsd + delta,
            sessionUsd: row.customUsd + delta,
            turnUsd: (row.turnUsd ?? 0) + delta,
            pricedBy: 'custom' as const,
          }))
          void persistReading($, written)
        } else {
          const written = await update($, reading, row => ({ ...row, tokens: withUsage(row.tokens, usage) }))
          void persistReading($, written)
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
    const { Box, Button, Text } = $.ui.resolve(e)
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

    // The band's one action: pull the installed plugin's next version, then
    // say how it lands. A folder install reads its folder, so this is mostly
    // a no-op there; a marketplace install fetches the new copy.
    const runUpdate = async (): Promise<void> => {
      try {
        const result = await $.process.run(
          ['claude', 'plugin', 'update', $.plugin.name],
          { timeoutMs: 120_000 },
        )
        const line = (result.stdout || result.stderr)
          .trim()
          .split(/\r?\n/)
          .filter(part => part.trim() !== '')
          .pop()

        if (result.exitCode === 0) {
          // Clear the button first, then ask the CLI again past the throttle,
          // then ask for the redraw: whichever of these the surface honours,
          // the row stops offering the version it just took.
          await update($, reading, row => ({ ...row, updateVersion: null }))
          lastCheckAt = 0
          void checkUpdate($)
          $.ui.invalidate('ui.render')
        }

        $.ui.toast(result.exitCode === 0
          ? `${line ?? '已更新'}；运行 /reload-plugins 生效`
          : `更新失败：${line ?? `exit ${result.exitCode}`}`)
      } catch (error) {
        $.ui.toast(`无法运行 claude：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // No newer version, no button: the slot keeps a blank Text so the tree's
    // shape does not change.
    const action = row.updateVersion !== null
      ? <Button key="update" label={`update ${row.updateVersion}`} onPress={runUpdate} />
      : <Text> </Text>

    // The Texts sit straight in the Box, the Button last, as the band's own
    // examples draw: a fragment or a wrapper Box is laid out as a column on
    // the desktop surface, so each child is a sibling here.
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
          <Text>  </Text>
          {action}
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
          <Text>  </Text>
          {action}
        </Box>
      </Box>
    )
  })
}
