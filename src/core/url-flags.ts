/**
 * Dev and test switches in the page URL (listed in the README): ?q=low|high, ?cam=chase|iso,
 * ?level=<url>, ?manual, ?nav, ?fps, ?boxes, ?touch, ?curve=0|1, ?sound=0|1, ?fresh. Read once at load; tools running under node see none.
 */
const params = new URLSearchParams(globalThis.location?.search ?? '');

/** `?name` is present, with or without a value. */
export const urlFlag = (name: string): boolean => params.has(name);

/** `?name=value`, or null. */
export const urlParam = (name: string): string | null => params.get(name);

/** `?name=` one of `options`, else null. */
export function urlChoice<const T extends string>(name: string, options: readonly T[]): T | null {
  const v = params.get(name);
  return v !== null && (options as readonly string[]).includes(v) ? (v as T) : null;
}
