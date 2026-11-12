/**
 * Region files as text: pretty-printed JSON, except that a position stays on one line. [lon, lat] on a
 * line of its own costs about 33 bytes instead of 68 as three-line arrays, and diffs still read one
 * vertex per line. Same data either way; only whitespace differs.
 */
const NUMBER = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const PAIR = new RegExp(String.raw`\[\s*(${NUMBER}),\s*(${NUMBER})\s*\]`, "g");

export function stringifyCompact(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(PAIR, "[$1, $2]");
}
