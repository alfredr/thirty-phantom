/**
 * Read URL options once at startup. See README.md for supported flags. Node tools have no location and use an empty
 * query string.
 */
const params = new URLSearchParams(globalThis.location?.search ?? '');

/** Return whether the query includes `name`, regardless of its value. */
export const urlFlag = (name: string): boolean => params.has(name);

/** Return the first query value for `name`, or null if absent. */
export const urlParam = (name: string): string | null => params.get(name);

/** Return the query value only if it matches one of `options`; otherwise return null. */
export function urlChoice<const T extends string>(name: string, options: readonly T[]): T | null {
  const v = params.get(name);
  return v !== null && (options as readonly string[]).includes(v) ? (v as T) : null;
}
