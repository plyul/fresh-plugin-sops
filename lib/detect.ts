// Recognising SOPS-encrypted documents. Pure functions, no editor access.

/** The document formats `sops --input-type/--output-type` understands. */
export type SopsFormat = "yaml" | "json" | "dotenv" | "ini" | "binary";

export const FORMATS: readonly SopsFormat[] = ["yaml", "json", "dotenv", "ini", "binary"];

/**
 * The format the sops CLI infers from a file name: a case-sensitive suffix
 * match, with everything else treated as binary (sops `formats.FormatForPath`).
 */
export function formatFromPath(path: string): SopsFormat {
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".env")) return "dotenv";
  if (path.endsWith(".ini")) return "ini";
  return "binary";
}

/**
 * The format of `text` when it is a SOPS-encrypted document, otherwise null.
 *
 * The format sops would infer from `path` is tried first, so a document that
 * fits several readings resolves the way the sops CLI resolves it; the others
 * cover files encrypted with an explicit `--input-type`.
 */
export function detectSops(path: string, text: string): SopsFormat | null {
  if (typeof text !== "string" || text === "") return null;
  const preferred = formatFromPath(path);
  const order = [preferred, ...FORMATS.filter((f) => f !== preferred)];
  let jsonShape: "json" | "binary" | null | undefined;
  for (const format of order) {
    switch (format) {
      case "yaml":
        if (isYamlSops(text)) return "yaml";
        break;
      case "dotenv":
        if (isDotenvSops(text)) return "dotenv";
        break;
      case "ini":
        if (isIniSops(text)) return "ini";
        break;
      case "json":
      case "binary":
        if (jsonShape === undefined) jsonShape = jsonSopsShape(text);
        if (jsonShape === "json") return "json";
        // A binary-format wrapper under a .json name is what `sops file.json` would read as JSON.
        if (jsonShape === "binary") return preferred === "json" ? "json" : "binary";
        break;
    }
  }
  return null;
}

/** Metadata keys every sops document carries, whatever the key type. */
const REQUIRED_METADATA = ["mac", "version", "lastmodified"];

function hasRequiredMetadata(keys: Set<string>): boolean {
  return REQUIRED_METADATA.every((k) => keys.has(k));
}

/** A top-level `sops:` mapping holding the sops metadata keys. */
function isYamlSops(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^sops:[ \t]*(#.*)?$/.test(lines[i])) continue;
    const keys = new Set<string>();
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") continue;
      if (!/^[ \t]/.test(line)) break;
      const m = /^[ \t]+([A-Za-z_]+):/.exec(line);
      if (m) keys.add(m[1]);
    }
    if (hasRequiredMetadata(keys)) return true;
  }
  return false;
}

/** The dotenv store flattens the metadata into `sops_*` keys. */
function isDotenvSops(text: string): boolean {
  const keys = new Set<string>();
  for (const m of text.matchAll(/^sops_([a-z_]+)=/gm)) keys.add(m[1]);
  return hasRequiredMetadata(keys);
}

/** The INI store keeps the metadata in a `[sops]` section. */
function isIniSops(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\[sops\][ \t]*$/.test(l));
  if (start < 0) return false;
  const keys = new Set<string>();
  for (let j = start + 1; j < lines.length; j++) {
    if (/^\[[^\]]+\][ \t]*$/.test(lines[j])) break;
    const m = /^([A-Za-z_]+)[ \t]*=/.exec(lines[j]);
    if (m) keys.add(m[1]);
  }
  return hasRequiredMetadata(keys);
}

/**
 * "json" for an encrypted JSON document, "binary" for the `{data, sops}`
 * wrapper sops writes for binary input, null otherwise.
 */
function jsonSopsShape(text: string): "json" | "binary" | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(doc) || !isRecord(doc.sops)) return null;
  const meta = doc.sops;
  if (!REQUIRED_METADATA.every((k) => typeof meta[k] === "string")) return null;
  const keys = Object.keys(doc);
  const isWrapper = keys.length === 2 && keys.includes("data") && typeof doc.data === "string";
  return isWrapper ? "binary" : "json";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
