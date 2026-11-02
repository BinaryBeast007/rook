// Find in chat: where a query occurs in the conversation's text, and how many messages to render.

/** Messages a long chat renders at first, and how many more each "Show earlier" adds. */
export const MESSAGE_PAGE = 40;

/** Start offsets of `query` in `text`, ignoring case, without overlaps; none for an empty query. */
export function matchOffsets(text: string, query: string): number[] {
  if (!query) return [];
  let haystack = text.toLowerCase();
  let needle = query.toLowerCase();
  // A few characters change length when lowercased (İ); offsets must stay the text's own.
  if (haystack.length !== text.length || needle.length !== query.length) {
    haystack = text;
    needle = query;
  }
  const offsets: number[] = [];
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  )
    offsets.push(at);
  return offsets;
}

/** The match after (or with `back`, before) `current` among `count`, wrapping around. */
export function stepMatch(current: number, count: number, back: boolean): number {
  if (count === 0) return 0;
  return (current + (back ? count - 1 : 1)) % count;
}

/** How many of `total` messages stay hidden above the `shown` most recent; none while finding. */
export function hiddenCount(total: number, shown: number, finding: boolean): number {
  return finding ? 0 : Math.max(0, total - shown);
}
