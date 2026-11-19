/**
 * The numeric parts of a version string (`v0.6.1`, `0.6.1-beta`), or null when
 * it has none.
 */
export function versionParts(version: string): number[] | null {
  const core = version.trim().replace(/^v/i, '').split(/[-+]/)[0] ?? ''

  if (core === '') {
    return null
  }

  const parts: number[] = []

  for (const part of core.split('.')) {
    if (!/^\d+$/.test(part)) {
      return null
    }

    parts.push(Number(part))
  }

  return parts
}

/**
 * Whether `latest` names a higher version than `current`: parts compare left
 * to right, a missing part counts as 0. Two strings it cannot parse differ
 * only when they are not equal.
 */
export function isNewer(latest: string, current: string): boolean {
  const next = versionParts(latest)
  const now = versionParts(current)

  if (next === null || now === null) {
    return latest.trim() !== current.trim()
  }

  const length = Math.max(next.length, now.length)

  for (let i = 0; i < length; i += 1) {
    const a = next[i] ?? 0
    const b = now[i] ?? 0

    if (a !== b) {
      return a > b
    }
  }

  return false
}

function fromGithubUrl(url: string): string | null {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/?#]+)/i)

  if (match === null) {
    return null
  }

  const owner = match[1]
  let repo = match[2] ?? ''

  if (repo.endsWith('.git')) {
    repo = repo.slice(0, -4)
  }

  return owner !== undefined && repo !== '' ? `${owner}/${repo}` : null
}

/**
 * The `owner/repo` a marketplace's source names, or null when it is not a
 * GitHub repository (a folder, an npm package, a gateway).
 */
export function repoOf(source: unknown): string | null {
  if (source === null || typeof source !== 'object') {
    return null
  }

  const entry = source as { source?: unknown; repo?: unknown; url?: unknown }

  if (entry.source === 'github' && typeof entry.repo === 'string') {
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repo)
      ? entry.repo.replace(/\.git$/, '')
      : null
  }

  if (typeof entry.url === 'string') {
    return fromGithubUrl(entry.url)
  }

  return null
}

/** Where a GitHub-hosted plugin's manifest sits at the repository's tip. */
export function pluginJsonUrl(repo: string): string {
  return `https://raw.githubusercontent.com/${repo}/HEAD/.claude-plugin/plugin.json`
}
