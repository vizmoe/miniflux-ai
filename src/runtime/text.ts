/** Trim suffix runs without retrying a greedy expression at every character. */
export function trimTrailingCharacters(value: string, characters: string) {
  let end = value.length;
  while (end > 0 && characters.includes(value[end - 1])) end--;
  return value.slice(0, end);
}
/** Consume each potential scheme once, including candidates without a delimiter. */
export function* absoluteUrlSpans(
  value: string,
  terminator: RegExp,
  wordBoundary = false,
) {
  const schemes = /[a-z][a-z0-9+.-]*/gi;
  for (let match = schemes.exec(value); match; match = schemes.exec(value)) {
    let start = match.index;
    if (wordBoundary && start > 0 && /\w/.test(value[start - 1])) {
      const boundary = /[.+-][a-z]/i.exec(match[0]);
      if (!boundary) continue;
      start += boundary.index + 1;
    }
    const delimiter = schemes.lastIndex;
    if (value.slice(delimiter, delimiter + 3) !== '://') continue;
    let end = delimiter + 3;
    while (end < value.length && !terminator.test(value[end])) end++;
    if (end > delimiter + 3) yield { start, end };
    schemes.lastIndex = end;
  }
}
