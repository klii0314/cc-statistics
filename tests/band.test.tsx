import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'cc-statistics',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 8,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 8 },
    view: {},
  },
} as const

const READING = {
  ttftMs: 1240,
  tps: 52.3,
  sessionUsd: 0.0421,
  turnUsd: 0.0042,
  isStreaming: false,
  tokens: { input: 1_500_000, cached: 1_326_000, output: 42_000 },
  pricedBy: 'ledger',
  customUsd: 0,
  updateVersion: '0.5.3',
  fields: { ttft: true, tps: true, tokens: true, cache: true, turn: true, session: true },
  isMenuOpen: false,
  rates: null,
  currency: 'usd',
  drafts: {},
}

test('the band draws TTFT, TPS, tokens, cache and cost on every surface', async ($, on) => {
  // What the mod's atom reads: the stored value and the version it stands at.
  on('state.get', () => ({
    value: { value: { shape: 'reading-8', value: READING }, version: 1 },
  }))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /TTFT/ }))?.text).toBe('TTFT ')
    expect((await ui.find({ type: 'Text', text: /1\.24s/ }))?.text).toBe('1.24s')
    expect((await ui.find({ type: 'Text', text: /52\.3 token\/s/ }))?.text).toBe('52.3 token/s')
    expect((await ui.find({ type: 'Text', text: /1\.54M/ }))?.text).toBe('1.54M')
    expect((await ui.find({ type: 'Text', text: /88\.40%/ }))?.text).toBe('88.40%')
    expect((await ui.find({ type: 'Text', text: /\$0\.0042/ }))?.text).toBe('$0.0042')
    expect((await ui.find({ type: 'Text', text: /\$0\.0421/ }))?.text).toBe('$0.0421')
    expect(await ui.find({ type: 'Button', key: 'update' })).toBeDefined()
    await ui.unmount()
  }
})

test('the stats are Text siblings in one Box, not a column', async ($, on) => {
  on('state.get', () => ({
    value: { value: { shape: 'reading-8', value: READING }, version: 1 },
  }))

  // A fragment in the tree is laid out as a column on the desktop surface, so
  // the wide row must hold plain Text children only.
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const tree = await ui.drawn()

  expect(tree.type).toBe('Box')

  const children = tree.type === 'Box' ? tree.children ?? [] : []
  expect(children).toHaveLength(16)

  for (const child of children.slice(1, 15)) {
    expect(typeof child === 'string' || child.type === 'Text').toBe(true)
  }
  await ui.unmount()
})

test('a narrow band moves the costs to a second line', async ($, on) => {
  on('state.get', () => ({
    value: { value: { shape: 'reading-8', value: READING }, version: 1 },
  }))

  const ui = await $.ui.mount({
    ...BAND,
    surface: 'desktop',
    props: { ...BAND.props, bodyColumns: 40 },
  })

  expect((await ui.find({ type: 'Text', text: /1\.54M/ }))?.text).toBe('1.54M')
  expect((await ui.find({ type: 'Text', text: /\$0\.0421/ }))?.text).toBe('$0.0421')
  await ui.unmount()
})

test('costs priced from the plugin rates show the symbol', async ($, on) => {
  on('state.get', () => ({
    value: {
      value: {
        shape: 'reading-8',
        value: { ...READING, pricedBy: 'custom', customUsd: 0.0042 },
      },
      version: 1,
    },
  }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /\$0\.0042/ }))?.text).toBe('$0.0042')
  expect((await ui.find({ type: 'Text', text: /\$0\.0421/ }))?.text).toBe('$0.0421')
  await ui.unmount()
})

test('tokens keep two decimals', async ($, on) => {
  on('state.get', () => ({
    value: {
      value: {
        shape: 'reading-8',
        value: {
          ...READING,
          tokens: { input: 52_000_000, cached: 51_900_000, output: 110_000 },
        },
      },
      version: 1,
    },
  }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /52\.11M/ }))?.text).toBe('52.11M')
  await ui.unmount()
})

test('before anything is measured the row shows dashes', async $ => {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /^—$/ }))?.text).toBe('—')
  await ui.unmount()
})

test('the currency switch moves the ledger costs at once', async ($, on) => {
  on('state.get', () => ({
    value: {
      value: { shape: 'reading-8', value: { ...READING, currency: 'cny' } },
      version: 1,
    },
  }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /¥0\.0042/ }))?.text).toBe('¥0.0042')
  expect((await ui.find({ type: 'Text', text: /¥0\.0421/ }))?.text).toBe('¥0.0421')
  await ui.unmount()
})

test('the menu holds the rate fields', async ($, on) => {
  on('state.get', () => ({
    value: {
      value: { shape: 'reading-8', value: { ...READING, isMenuOpen: true } },
      version: 1,
    },
  }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ key: 'rate-input' })).toBeDefined()
  expect(await ui.find({ key: 'rate-cacheRead' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'cur-cny' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /\/ 1M tokens/ }))?.text).toBe('/ 1M tokens')
  await ui.unmount()
})

test('the rate fields show the rate in force', async ($, on) => {
  on('state.get', () => ({
    value: {
      value: {
        shape: 'reading-8',
        value: {
          ...READING,
          isMenuOpen: true,
          rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        },
      },
      version: 1,
    },
  }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ key: 'rate-input' }))?.text).toContain('3')
  expect((await ui.find({ key: 'rate-cacheWrite' }))?.text).toContain('3.75')
  await ui.unmount()
})

test('a field turned off draws nothing of itself', async ($, on) => {
  on('state.get', () => ({
    value: {
      value: {
        shape: 'reading-8',
        value: {
          ...READING,
          fields: { ...READING.fields, ttft: false },
        },
      },
      version: 1,
    },
  }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /TTFT/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /TPS/ }))?.text).toBe('   TPS ')
  await ui.unmount()
})

test('costs priced by the plugin follow the chosen currency', async ($, on) => {
  on('state.get', () => ({
    value: {
      value: {
        shape: 'reading-8',
        value: { ...READING, pricedBy: 'custom', currency: 'cny', customUsd: 0.0042 },
      },
      version: 1,
    },
  }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /¥0\.0042/ }))?.text).toBe('¥0.0042')
  expect((await ui.find({ type: 'Text', text: /¥0\.0421/ }))?.text).toBe('¥0.0421')
  await ui.unmount()
})

test('no newer version means no update button', async ($, on) => {
  on('state.get', () => ({
    value: {
      value: { shape: 'reading-8', value: { ...READING, updateVersion: null } },
      version: 1,
    },
  }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Button', key: 'update' })).toBeUndefined()
  await ui.unmount()
})

test('a survey holds the band', async $ => {
  const ui = await $.ui.mount({
    ...BAND,
    surface: 'desktop',
    props: { ...BAND.props, hasSurvey: true },
  })

  expect(await ui.find({ type: 'Text', text: /TTFT/ })).toBeUndefined()
  await ui.unmount()
})
