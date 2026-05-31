let statsCacheVersion = 0

export function invalidateStatsCaches(): void {
  statsCacheVersion += 1
}

export function getStatsCacheVersion(): number {
  return statsCacheVersion
}
