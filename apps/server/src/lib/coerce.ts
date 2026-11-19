/** Readers for loosely typed third-party JSON: each returns an empty value for anything off-shape. */

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** An array of strings, or a comma-separated string, as trimmed non-empty strings. */
export const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((x) => String(x).trim()).filter(Boolean)
    : typeof v === 'string' && v.trim()
      ? v.split(',').map((x) => x.trim()).filter(Boolean)
      : [];
