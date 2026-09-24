// Path and naming helpers. Pure functions, POSIX paths only.

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return trimmed.slice(0, i);
}

/**
 * Resolve a user-supplied path: `~` and `~/…` against `home`, relative paths
 * against `base`, absolute paths as they are.
 */
export function resolveUserPath(input: string, base: string, home: string): string {
  const p = input.trim();
  if (p === "") return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return joinPath(home, p.slice(2));
  if (p.startsWith("/")) return normalize(p);
  return joinPath(base, p);
}

export function joinPath(a: string, b: string): string {
  return normalize(`${a.replace(/\/+$/, "")}/${b}`);
}

/** Collapse `//`, `.` and `..` segments of an absolute or relative path. */
export function normalize(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

/** A path as short as it can be shown: relative to `cwd` below it, `~/…` below `home`. */
export function displayPath(path: string, cwd: string, home: string): string {
  const base = cwd.replace(/\/+$/, "");
  if (base !== "" && path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  const h = home.replace(/\/+$/, "");
  if (h !== "" && path.startsWith(`${h}/`)) return `~/${path.slice(h.length + 1)}`;
  return path;
}

/**
 * Tab title for the decrypted buffer of `path`. The parent directory is added
 * when another open decrypted buffer shows a file with the same name.
 */
export function decryptedBufferName(path: string, otherPaths: Iterable<string>): string {
  const name = basename(path);
  for (const other of otherPaths) {
    if (other !== path && basename(other) === name) {
      return `${basename(dirname(path))}/${name} [sops]`;
    }
  }
  return `${name} [sops]`;
}
