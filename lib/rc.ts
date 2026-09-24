// The `.sopsrc` project file with per-project credentials. Pure functions.

/** Settings a `.sopsrc` may override. */
export interface RcFile {
  ageKeyFile?: string;
  awsProfile?: string;
  gcpCredentialsPath?: string;
}

const KEYS: readonly (keyof RcFile)[] = ["ageKeyFile", "awsProfile", "gcpCredentialsPath"];

/**
 * Parse a `.sopsrc`: flat YAML `key: value` lines, values optionally quoted,
 * `#` comments. Unknown keys and anything nested are ignored.
 */
export function parseRc(text: string): RcFile {
  const out: RcFile = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([A-Za-z]+)[ \t]*:[ \t]*(.*)$/.exec(raw);
    if (!m) continue;
    const key = m[1] as keyof RcFile;
    if (!KEYS.includes(key)) continue;
    const value = unquote(stripComment(m[2]).trim());
    if (value !== "") out[key] = value;
  }
  return out;
}

function stripComment(value: string): string {
  const v = value.trim();
  if (v.startsWith('"') || v.startsWith("'")) return v;
  const i = v.search(/\s#/);
  return i < 0 ? v : v.slice(0, i);
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q)) return value.slice(1, -1);
  }
  return value;
}
