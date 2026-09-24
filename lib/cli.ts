// Building sops invocations and reading their failures. Pure functions, no editor access.

import type { SopsFormat } from "./detect.ts";

/**
 * Stands in for `$SOPS_EDITOR` during `sops edit`: copies the prepared
 * plaintext over the temporary file sops hands it.
 *
 * sops re-opens the editor after a parse error and waits for a key press
 * first. The marker makes the second run fail, so sops exits instead of
 * looping. Paths travel in environment variables, so the command itself never
 * needs quoting (sops splits it with shlex).
 */
export const FAKE_EDITOR =
  `sh -c '[ -e "$FRESH_SOPS_MARKER" ] && exit 3; : >"$FRESH_SOPS_MARKER" && cat "$FRESH_SOPS_SRC" >"$1"' fresh-sops-editor`;

export interface Invocation {
  command: string;
  args: string[];
}

/**
 * Runs sops through `sh` (stdin from /dev/null, so nothing waits on the
 * editor's terminal) and `env` (the editor's process API cannot set
 * variables). Empty values are dropped rather than set to "".
 */
export function wrapSops(binPath: string, env: Record<string, string>, sopsArgs: string[]): Invocation {
  const assignments = Object.entries(env)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}=${value}`);
  return {
    command: "sh",
    args: ["-c", 'exec "$@" </dev/null', "fresh-sops", "env", ...assignments, binPath, ...sopsArgs],
  };
}

export interface SopsFlags {
  ignoreMac: boolean;
  macOnlyEncrypted: boolean;
  /** Replaces the `.sops.yaml` lookup, e.g. "/dev/null" to work around sops#884. */
  config?: string;
}

/** Flags sops only reads before the subcommand. */
function globalFlags(flags: SopsFlags, encrypting: boolean): string[] {
  const out: string[] = [];
  if (flags.config) out.push("--config", flags.config);
  if (encrypting && flags.macOnlyEncrypted) out.push("--mac-only-encrypted");
  return out;
}

function typeFlags(format: SopsFormat): string[] {
  return ["--input-type", format, "--output-type", format];
}

/** Decrypt `path` to stdout. */
export function decryptArgs(format: SopsFormat, path: string, flags: SopsFlags): string[] {
  return [
    ...globalFlags(flags, false),
    "decrypt",
    ...typeFlags(format),
    ...(flags.ignoreMac ? ["--ignore-mac"] : []),
    path,
  ];
}

/** Re-encrypt `path` in place with the plaintext the fake editor supplies. */
export function editArgs(format: SopsFormat, path: string, flags: SopsFlags): string[] {
  return [
    ...globalFlags(flags, false),
    "edit",
    ...typeFlags(format),
    ...(flags.ignoreMac ? ["--ignore-mac"] : []),
    path,
  ];
}

/** Encrypt an existing plaintext file in place, by the `.sops.yaml` rules for its path. */
export function encryptInPlaceArgs(path: string, flags: SopsFlags): string[] {
  return [...globalFlags(flags, true), "encrypt", "--in-place", path];
}

/** Encrypt `plainPath` into a new file `target`, by the `.sops.yaml` rules for `target`. */
export function encryptNewArgs(format: SopsFormat, target: string, plainPath: string, flags: SopsFlags): string[] {
  return [
    ...globalFlags(flags, true),
    "encrypt",
    "--filename-override",
    target,
    ...typeFlags(format),
    "--output",
    target,
    plainPath,
  ];
}

/** Environment for `sops edit` driven by FAKE_EDITOR; sops' own temp file goes to `tmpDir`. */
export function editEnv(plainPath: string, markerPath: string, tmpDir: string): Record<string, string> {
  return {
    SOPS_EDITOR: FAKE_EDITOR,
    FRESH_SOPS_SRC: plainPath,
    FRESH_SOPS_MARKER: markerPath,
    TMPDIR: tmpDir,
  };
}

export interface Credentials {
  ageKeyFile?: string;
  awsProfile?: string;
  gcpCredentialsPath?: string;
}

export function credentialEnv(creds: Credentials): Record<string, string> {
  const env: Record<string, string> = {};
  if (creds.ageKeyFile) env.SOPS_AGE_KEY_FILE = creds.ageKeyFile;
  if (creds.awsProfile) env.AWS_PROFILE = creds.awsProfile;
  if (creds.gcpCredentialsPath) env.GOOGLE_APPLICATION_CREDENTIALS = creds.gcpCredentialsPath;
  return env;
}

// sops exit codes (cmd/sops/codes).
export const EXIT_MAC_MISMATCH = 51;
export const EXIT_MAC_NOT_FOUND = 52;
export const EXIT_CONFIG_NOT_FOUND = 61;
export const EXIT_COULD_NOT_RETRIEVE_KEY = 128;
export const EXIT_FILE_NOT_MODIFIED = 200;
export const EXIT_FILE_ALREADY_ENCRYPTED = 203;
/** What the plugin reports for a run it killed after the timeout. */
export const EXIT_TIMEOUT = -2;

export type FailureKind =
  | "unchanged"
  | "missing-binary"
  | "invalid-content"
  | "mac-mismatch"
  | "no-key"
  | "no-creation-rule"
  | "no-config"
  | "config-error"
  | "already-encrypted"
  | "timeout"
  | "other";

export interface Failure {
  kind: FailureKind;
  /** The most useful single line of sops' output. */
  detail: string;
}

/** What went wrong with a sops run that exited non-zero. */
export function classifyFailure(exitCode: number, stderr: string): Failure {
  const text = stderr.trim();
  if (exitCode === EXIT_TIMEOUT) return { kind: "timeout", detail: "" };
  if (exitCode === EXIT_FILE_NOT_MODIFIED || text.includes("File has not changed")) {
    return { kind: "unchanged", detail: "" };
  }
  // `env` exits 127 when it cannot find sops and 126 when it cannot run it
  // (its message is localized); the editor reports -1 when `sh` itself is missing.
  if (exitCode === 127 || exitCode === 126 || (exitCode === -1 && /os error 2|No such file/i.test(text))) {
    return { kind: "missing-binary", detail: firstLine(text) };
  }
  // sops' editor loop: the content did not parse or cannot be encrypted.
  if (
    /Could not load tree|Tree not valid for encryption|SOPS metadata is invalid|No master keys were provided/.test(text)
  ) {
    return { kind: "invalid-content", detail: logDetail(text) };
  }
  if (exitCode === EXIT_MAC_MISMATCH || exitCode === EXIT_MAC_NOT_FOUND || /MAC mismatch|MAC not found/i.test(text)) {
    return { kind: "mac-mismatch", detail: firstLine(text) };
  }
  if (exitCode === EXIT_COULD_NOT_RETRIEVE_KEY || text.includes("Failed to get the data key")) {
    return { kind: "no-key", detail: keyDetail(text) };
  }
  if (text.includes("no matching creation rules found")) return { kind: "no-creation-rule", detail: firstLine(text) };
  if (exitCode === EXIT_CONFIG_NOT_FOUND || text.includes("config file not found")) {
    return { kind: "no-config", detail: firstLine(text) };
  }
  if (text.includes("error loading config")) return { kind: "config-error", detail: firstLine(text) };
  if (exitCode === EXIT_FILE_ALREADY_ENCRYPTED) return { kind: "already-encrypted", detail: firstLine(text) };
  return { kind: "other", detail: firstLine(text) || `exit code ${exitCode}` };
}

/** First non-empty line, without the `[CMD] time=… level=…` prefix of sops' logger. */
export function firstLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const msg = /\bmsg="((?:[^"\\]|\\.)*)"/.exec(line);
    return msg ? unescape(msg[1]) : line;
  }
  return "";
}

/** The `error="…"` field of a logrus line, else its message without the key-press prompt. */
function logDetail(text: string): string {
  const err = /\berror="((?:[^"\\]|\\.)*)"/.exec(text);
  if (err) return unescape(err[1]);
  return firstLine(text).replace(/\s*Press enter to return to the editor.*$/, "");
}

/** The first per-key failure reason, which says more than the generic headline. */
function keyDetail(text: string): string {
  const lines = text.split(/\r?\n/);
  const reason: string[] = [];
  for (const raw of lines) {
    const m = /^\s*-?\s*\|\s?(.*)$/.exec(raw);
    if (m) {
      reason.push(m[1].trim());
    } else if (reason.length > 0) {
      break;
    }
  }
  return reason.length > 0 ? reason.join(" ") : firstLine(text);
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}
