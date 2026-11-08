/** Feeds (or highlights) without the ones marked `extra`. Returns the input unchanged when none are. */
export function withoutExtra<T extends { event: { extra?: boolean } }>(feeds: Record<string, T>): Record<string, T> {
  const entries = Object.entries(feeds);
  return entries.some(([, f]) => f.event.extra) ? Object.fromEntries(entries.filter(([, f]) => !f.event.extra)) : feeds;
}

/** Number of extra feeds still on air. */
export function countExtra(feeds: Record<string, { event: { extra?: boolean }; status: string }>): number {
  return Object.values(feeds).filter((f) => f.event.extra && f.status !== 'ended').length;
}
