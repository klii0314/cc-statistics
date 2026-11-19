import { expect, test } from 'claude-code/testing'

import { ALL_FIELDS, readFields, sameFields } from '../hooks/fields'

test('a saved selection reads back field by field', () => {
  expect(readFields({ ttft: false, tps: true, tokens: false, cache: true, turn: false, session: true }))
    .toEqual({ ttft: false, tps: true, tokens: false, cache: true, turn: false, session: true })
})

test('anything else is no selection at all', () => {
  expect(readFields(null)).toBeNull()
  expect(readFields({ ttft: true })).toBeNull()
  expect(readFields({ ...ALL_FIELDS, tps: 'yes' })).toBeNull()
})

test('two selections compare by their six flags', () => {
  expect(sameFields(ALL_FIELDS, { ...ALL_FIELDS })).toBe(true)
  expect(sameFields(ALL_FIELDS, { ...ALL_FIELDS, turn: false })).toBe(false)
})
