import { expect, test } from 'claude-code/testing'

import { costOf, hasRates, parsePricing, ratesFor } from '../hooks/pricing'

const ROW = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

test('a response is priced per token kind, per million, times the multiplier', () => {
  const pricing = parsePricing({ multiplier: 0.5, models: { 'claude-sonnet-5-5': ROW } })

  if (pricing === null) {
    throw new Error('the file should parse')
  }

  const rates = ratesFor(pricing, 'claude-sonnet-5-5')

  if (rates === null) {
    throw new Error('the model should match')
  }

  const usd = costOf(rates, {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  }, pricing.multiplier)

  expect(Math.abs(usd - (3 + 15 + 0.3 + 3.75) * 0.5) < 1e-9).toBe(true)
})

test('a model id matches its exact row, then the longest part of it, then the fallback', () => {
  const pricing = parsePricing({
    models: { sonnet: ROW, 'claude-sonnet-5-5': { ...ROW, output: 99 } },
    fallback: { ...ROW, output: 7 },
  })

  if (pricing === null) {
    throw new Error('the file should parse')
  }

  expect(ratesFor(pricing, 'claude-sonnet-5-5')?.output).toBe(99)
  expect(ratesFor(pricing, 'claude-sonnet-5-5-20260101')?.output).toBe(99)
  expect(ratesFor(pricing, 'claude-haiku-9')?.output).toBe(7)
})

test('a malformed row costs that model only, and a bad multiplier reads as 1', () => {
  const pricing = parsePricing({
    multiplier: 0,
    models: { good: ROW, bad: { input: 1 } },
  })

  if (pricing === null) {
    throw new Error('the file should parse')
  }

  expect(pricing.multiplier).toBe(1)
  expect(Object.keys(pricing.models)).toEqual(['good'])
  expect(hasRates(pricing)).toBe(true)
  expect(ratesFor(pricing, 'nothing')).toBeNull()
})

test('a file with no rate row only scales the ledger', () => {
  const pricing = parsePricing({ multiplier: 0.2 })

  if (pricing === null) {
    throw new Error('the file should parse')
  }

  expect(hasRates(pricing)).toBe(false)
  expect(pricing.multiplier).toBe(0.2)
})

test('anything but a JSON object is no pricing at all', () => {
  expect(parsePricing(null)).toBeNull()
  expect(parsePricing([])).toBeNull()
  expect(parsePricing('rates')).toBeNull()
})
