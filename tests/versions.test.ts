import { expect, test } from 'claude-code/testing'

import { isNewer, pluginJsonUrl, repoOf, versionParts } from '../hooks/versions'

test('versions compare by their parts', () => {
  expect(isNewer('0.5.6', '0.5.5')).toBe(true)
  expect(isNewer('0.5.5', '0.5.5')).toBe(false)
  expect(isNewer('0.5.10', '0.5.9')).toBe(true)
  expect(isNewer('1.0', '0.9.9')).toBe(true)
  expect(isNewer('v1.2.3', '1.2.3')).toBe(false)
  expect(isNewer('0.5.6-beta', '0.5.5')).toBe(true)
  expect(versionParts('not a version')).toBeNull()
})

test('a marketplace source names its GitHub repository', () => {
  expect(repoOf({ source: 'github', repo: 'klii0314/cc-statistics' })).toBe('klii0314/cc-statistics')
  expect(repoOf({ source: 'git', url: 'https://github.com/klii0314/cc-statistics.git' }))
    .toBe('klii0314/cc-statistics')
  expect(repoOf({ source: 'directory', path: 'C:/somewhere' })).toBeNull()
  expect(repoOf(null)).toBeNull()
})

test('the manifest URL points at the repository tip', () => {
  expect(pluginJsonUrl('klii0314/cc-statistics'))
    .toBe('https://raw.githubusercontent.com/klii0314/cc-statistics/HEAD/.claude-plugin/plugin.json')
})
