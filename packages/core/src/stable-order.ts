export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function uniqueSortedStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}
