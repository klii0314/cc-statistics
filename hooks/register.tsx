import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Fields, Reading, Tokens } from '../types'
import { ALL_FIELDS, readFields, sameFields } from './fields'
import { costOf, hasRates, parsePricing, ratesFor, readRates } from './pricing'
import type { Pricing, Rates } from './pricing'
import { isNewer, pluginJsonUrl, repoOf } from './versions'

const NO_TOKENS: Tokens = { input: 0, cached: 0, output: 0 }

const ZERO_RATES: Rates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

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
  fields: ALL_FIELDS,
  isMenuOpen: false,
  rates: null,
  currency: 'usd',
}

// The band's one value: a write redraws the row the hook read it in.
const reading = atom(
  { plugin: 'cc-statistics', key: 'reading' } as const,
  EMPTY,
  { shape: 'reading-7' },
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

function money(amount: number, symbol: string): string {
  if (amount === 0) {
    return `${symbol}0.00`
  }

  return amount < 0.1 ? `${symbol}${amount.toFixed(4)}` : `${symbol}${amount.toFixed(2)}`
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

// ---- the selection every session shares ----------------------------------
// The six switches are one setting, not one per session: a toggle writes it to
// `$.store`, and every session reads it back at its start and on a timer.
const FIELDS_KEY = 'fields'
const FIELD_SYNC_MS = 3000

async function savedFields($: EngineInterface): Promise<Fields | null> {
  try {
    return readFields(await $.store.get(FIELDS_KEY))
  } catch {
    return null
  }
}

async function saveFields($: EngineInterface, fields: Fields): Promise<void> {
  try {
    await $.store.set(FIELDS_KEY, fields)
  } catch {
    // A refused write leaves the other sessions as they were.
  }
}

// ---- rates typed in the band ----------------------------------------------
// The four prices live in `$.store` too, so every session prices the same and
// a value survives a restart. They become the fallback row of the pricing
// table: a model-specific row in pricing.json still wins.
const RATES_KEY = 'rates'

async function savedRates($: EngineInterface): Promise<Rates | null> {
  try {
    return readRates(await $.store.get(RATES_KEY))
  } catch {
    return null
  }
}

async function saveRates($: EngineInterface, rates: Rates): Promise<void> {
  try {
    await $.store.set(RATES_KEY, rates)
  } catch {
    // A refused write costs the next session the value, never this row.
  }
}

function sameRates(a: Rates | null, b: Rates | null): boolean {
  if (a === null || b === null) {
    return a === b
  }

  return a.input === b.input
    && a.output === b.output
    && a.cacheRead === b.cacheRead
    && a.cacheWrite === b.cacheWrite
}

// ---- the unit the costs are shown in --------------------------------------
const CURRENCY_KEY = 'currency'

async function savedCurrency($: EngineInterface): Promise<'usd' | 'cny' | null> {
  try {
    const raw = await $.store.get(CURRENCY_KEY)

    return raw === 'usd' || raw === 'cny' ? raw : null
  } catch {
    return null
  }
}

async function saveCurrency($: EngineInterface, currency: 'usd' | 'cny'): Promise<void> {
  try {
    await $.store.set(CURRENCY_KEY, currency)
  } catch {
    // A refused write leaves the other sessions as they were.
  }
}

function withRates(pricing: Pricing | null, rates: Rates | null): Pricing | null {
  if (rates === null) {
    return pricing
  }

  return pricing === null
    ? { multiplier: 1, models: {}, fallback: rates }
    : { ...pricing, fallback: rates }
}

export const register: Register = on => {
  // The session's total when the main loop's current turn began; the module's
  // own, so a reload starts the turn's cost afresh.
  let turnStartUsd: number | null = null
  let pricing: Pricing | null = null
  // The file's table alone, so a rate typed in the band can always be merged
  // back in over it.
  let filePricing: Pricing | null = null
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
    // Follow the selection another session saved, then keep following it.
    const shared = await savedFields($)

    if (shared !== null && !sameFields(shared, (await read($, reading)).fields)) {
      await update($, reading, row => ({ ...row, fields: shared }))
    }

    const sharedRates = await savedRates($)
    await update($, reading, row => (sameRates(row.rates, sharedRates) ? row : { ...row, rates: sharedRates }))

    const sharedCurrency = await savedCurrency($)

    if (sharedCurrency !== null && (await read($, reading)).currency !== sharedCurrency) {
      await update($, reading, row => ({ ...row, currency: sharedCurrency }))
    }

    $.clock.every(FIELD_SYNC_MS, async () => {
      const saved = await savedFields($)

      if (saved !== null) {
        await update($, reading, row => (sameFields(row.fields, saved) ? row : { ...row, fields: saved }))
      }

      const rates = await savedRates($)
      await update($, reading, row => (sameRates(row.rates, rates) ? row : { ...row, rates }))

      const currency = await savedCurrency($)

      if (currency !== null) {
        await update($, reading, row => (row.currency === currency ? row : { ...row, currency }))
      }
    })

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
    filePricing = await loadPricing($)
    pricing = withRates(filePricing, (await read($, reading)).rates)
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
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const ttft = row.ttftMs !== null ? seconds(row.ttftMs) : row.isStreaming ? '…' : '—'
    const tps = row.tps !== null
      ? `${rate(row.tps)} token/s`
      : row.isStreaming ? '…' : '—'
    const moved = row.tokens.input + row.tokens.output
    const tokens = moved > 0 ? count(moved) : '—'
    const cache = percent(row.tokens.cached, row.tokens.input)
    const star = row.pricedBy === 'custom' ? '*' : ''
    // The engine's ledger is US dollars; only the plugin's own numbers follow
    // the chosen unit.
    const symbol = row.pricedBy === 'custom' && row.currency === 'cny' ? '¥' : '$'
    const turn = row.turnUsd !== null ? `${money(row.turnUsd, symbol)}${star}` : '—'
    const session = row.sessionUsd !== null ? `${money(row.sessionUsd, symbol)}${star}` : '—'

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

    // The menu on the left turns each reading on or off. A hidden reading
    // draws an empty Text, so the row's shape never changes.
    const f = row.fields

    const toggleMenu = (): void => {
      void update($, reading, row => ({ ...row, isMenuOpen: !row.isMenuOpen }))
    }

    const toggleField = async (name: keyof Fields): Promise<void> => {
      const written = await update($, reading, row => {
        const fields: Fields = { ...row.fields }
        fields[name] = !fields[name]

        return { ...row, fields }
      })
      // The other sessions read this key back on their own clock.
      void saveFields($, written.fields)
    }

    // A rate typed here becomes this session's fallback row at once, and the
    // other sessions pick it up from the store.
    const submitRate = async (name: keyof Rates, text: string): Promise<void> => {
      const trimmed = text.trim()
      const value = Number(trimmed)

      if (trimmed === '' || !Number.isFinite(value) || value < 0) {
        $.ui.toast('费率要填非负数字（美元 / 百万 token）')

        return
      }

      const current = (await read($, reading)).rates ?? pricing?.fallback ?? ZERO_RATES
      const rates: Rates = { ...current }
      rates[name] = value

      await update($, reading, row => ({ ...row, rates }))
      void saveRates($, rates)
      pricing = withRates(filePricing, rates)
    }

    const setCurrency = async (value: 'usd' | 'cny'): Promise<void> => {
      await update($, reading, row => ({ ...row, currency: value }))
      void saveCurrency($, value)
    }

    const rateText = (name: keyof Rates): string => {
      const value = row.rates?.[name]

      return value === undefined ? '' : String(value)
    }

    const menu = (
      <Box flexDirection="column" gap="xs">
        <Box gap="xs" paddingX={1}>
          <Button key="f-ttft" label={`${f.ttft ? '✓' : '·'} ttft`} onPress={() => toggleField('ttft')} />
          <Button key="f-tps" label={`${f.tps ? '✓' : '·'} tps`} onPress={() => toggleField('tps')} />
          <Button key="f-tokens" label={`${f.tokens ? '✓' : '·'} tokens`} onPress={() => toggleField('tokens')} />
          <Button key="f-cache" label={`${f.cache ? '✓' : '·'} cache`} onPress={() => toggleField('cache')} />
          <Button key="f-turn" label={`${f.turn ? '✓' : '·'} turn`} onPress={() => toggleField('turn')} />
          <Button key="f-session" label={`${f.session ? '✓' : '·'} session`} onPress={() => toggleField('session')} />
        </Box>
        <Box gap="sm" paddingX={1}>
          <Button
            key="cur-usd"
            label={`${row.currency === 'usd' ? '✓' : '·'} $`}
            onPress={() => setCurrency('usd')}
          />
          <Button
            key="cur-cny"
            label={`${row.currency === 'cny' ? '✓' : '·'} ¥`}
            onPress={() => setCurrency('cny')}
          />
          <Text dimColor>/ 1M tokens</Text>
          <Input
            key="rate-input"
            label="input "
            placeholder="0"
            value={rateText('input')}
            onSubmit={value => submitRate('input', value)}
          />
          <Input
            key="rate-output"
            label="output "
            placeholder="0"
            value={rateText('output')}
            onSubmit={value => submitRate('output', value)}
          />
          <Input
            key="rate-cacheRead"
            label="cacheRead "
            placeholder="0"
            value={rateText('cacheRead')}
            onSubmit={value => submitRate('cacheRead', value)}
          />
          <Input
            key="rate-cacheWrite"
            label="cacheWrite "
            placeholder="0"
            value={rateText('cacheWrite')}
            onSubmit={value => submitRate('cacheWrite', value)}
          />
        </Box>
      </Box>
    )

    // The Texts sit straight in a Box, as the band's own examples draw: a
    // fragment or a wrapper Box is laid out as a column on the desktop
    // surface, so each child is a sibling here.
    const line = (
      <Box paddingX={1}>
        <Button key="more" label="☰" dimColor onPress={toggleMenu} />
        <Text>  </Text>
        <Text dimColor>{f.ttft ? 'TTFT ' : ''}</Text>
        <Text color="claude">{f.ttft ? ttft : ''}</Text>
        <Text dimColor>{f.tps ? '   TPS ' : ''}</Text>
        <Text color="claude">{f.tps ? tps : ''}</Text>
        <Text dimColor>{f.tokens ? '   tokens ' : ''}</Text>
        <Text color="claude">{f.tokens ? tokens : ''}</Text>
        <Text dimColor>{f.cache ? '   cache ' : ''}</Text>
        <Text color="suggestion">{f.cache ? cache : ''}</Text>
        <Text dimColor>{f.turn ? '   turn ' : ''}</Text>
        <Text color="warning">{f.turn ? turn : ''}</Text>
        <Text dimColor>{f.session ? '   session ' : ''}</Text>
        <Text color="success">{f.session ? session : ''}</Text>
        <Text>  </Text>
        {action}
      </Box>
    )

    if (e.props.bodyColumns >= WIDE_COLUMNS) {
      return row.isMenuOpen ? (
        <Box flexDirection="column" gap="sm">
          {line}
          {menu}
        </Box>
      ) : line
    }

    const first = (
      <Box paddingX={1}>
        <Button key="more" label="☰" dimColor onPress={toggleMenu} />
        <Text>  </Text>
        <Text dimColor>{f.ttft ? 'TTFT ' : ''}</Text>
        <Text color="claude">{f.ttft ? ttft : ''}</Text>
        <Text dimColor>{f.tps ? '   TPS ' : ''}</Text>
        <Text color="claude">{f.tps ? tps : ''}</Text>
        <Text dimColor>{f.tokens ? '   tokens ' : ''}</Text>
        <Text color="claude">{f.tokens ? tokens : ''}</Text>
        <Text dimColor>{f.cache ? '   cache ' : ''}</Text>
        <Text color="suggestion">{f.cache ? cache : ''}</Text>
      </Box>
    )

    const second = (
      <Box paddingX={1}>
        <Text dimColor>{f.turn ? 'turn ' : ''}</Text>
        <Text color="warning">{f.turn ? turn : ''}</Text>
        <Text dimColor>{f.session ? '   session ' : ''}</Text>
        <Text color="success">{f.session ? session : ''}</Text>
        <Text>  </Text>
        {action}
      </Box>
    )

    return row.isMenuOpen ? (
      <Box flexDirection="column" gap="sm">
        {first}
        {second}
        {menu}
      </Box>
    ) : (
      <Box flexDirection="column">
        {first}
        {second}
      </Box>
    )
  })
}
