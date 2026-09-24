/// <reference path="./types/fresh.d.ts" />

// SOPS for Fresh.
//
// A SOPS-encrypted file opens as an in-memory ("virtual") buffer holding its
// decrypted text, and Ctrl+S in that buffer re-encrypts the file through
// `sops edit`, which keeps its data key, key groups and other metadata. The
// plaintext never lives in a file-backed buffer, so crash recovery, hot exit,
// session restore and language servers never see it. It reaches the disk only
// while sops runs: in a private temporary directory that is removed right
// after, and in sops' own temporary file, which is kept in that directory too.

import { detectSops, formatFromPath } from "./lib/detect.ts";
import type { SopsFormat } from "./lib/detect.ts";
import {
  classifyFailure,
  credentialEnv,
  decryptArgs,
  editArgs,
  editEnv,
  encryptInPlaceArgs,
  encryptNewArgs,
  EXIT_TIMEOUT,
  wrapSops,
} from "./lib/cli.ts";
import type { Credentials, Failure, SopsFlags } from "./lib/cli.ts";
import { basename, decryptedBufferName, dirname, displayPath, joinPath, resolveUserPath } from "./lib/paths.ts";
import { parseRc } from "./lib/rc.ts";

const editor = getEditor();

/** Buffer mode of decrypted buffers; also the palette context of their commands. */
const MODE = "sops";
const STATUS_TOKEN = "status";
/** Generous, because a PGP passphrase prompt runs inside it. */
const SOPS_TIMEOUT_MS = 120000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TEMP_PREFIX = "fresh-sops.";
/** Typing this recently makes clearing the modified flag unsafe (see markClean). */
const QUIET_BEFORE_CLEAN_MS = 300;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

type AutoDecrypt = "trusted" | "always" | "never";

interface Settings {
  autoDecrypt: AutoDecrypt;
  binPath: string;
  ageKeyFile: string;
  awsProfile: string;
  gcpCredentialsPath: string;
  configPath: string;
  ignoreMac: boolean;
  macOnlyEncrypted: boolean;
  creationEnabled: boolean;
  autoSaveDelay: number;
}

const DEFAULTS: Settings = {
  autoDecrypt: "trusted",
  binPath: "sops",
  ageKeyFile: "",
  awsProfile: "",
  gcpCredentialsPath: "",
  configPath: ".sopsrc",
  ignoreMac: false,
  macOnlyEncrypted: false,
  creationEnabled: false,
  autoSaveDelay: 0,
};

editor.defineConfigEnum("autoDecrypt", {
  values: ["trusted", "always", "never"] as const,
  default: DEFAULTS.autoDecrypt,
  description:
    'Decrypt SOPS files when they are opened: only in trusted workspaces, always, or never (use "SOPS: Decrypt Current File")',
});
editor.defineConfigString("binPath", {
  default: DEFAULTS.binPath,
  description: "sops executable, a name looked up on PATH or an absolute path",
});
editor.defineConfigString("ageKeyFile", {
  default: DEFAULTS.ageKeyFile,
  description: "age key file passed to sops as SOPS_AGE_KEY_FILE (empty: sops defaults)",
});
editor.defineConfigString("awsProfile", {
  default: DEFAULTS.awsProfile,
  description: "AWS profile passed to sops as AWS_PROFILE (empty: environment)",
});
editor.defineConfigString("gcpCredentialsPath", {
  default: DEFAULTS.gcpCredentialsPath,
  description: "GCP credentials file passed to sops as GOOGLE_APPLICATION_CREDENTIALS (empty: environment)",
});
editor.defineConfigString("configPath", {
  default: DEFAULTS.configPath,
  description:
    "Project file overriding ageKeyFile/awsProfile/gcpCredentialsPath, relative to the workspace (flat YAML key: value). Read only in trusted workspaces; empty disables it",
});
editor.defineConfigBoolean("ignoreMac", {
  default: DEFAULTS.ignoreMac,
  description: "Pass --ignore-mac when decrypting and saving",
});
editor.defineConfigBoolean("macOnlyEncrypted", {
  default: DEFAULTS.macOnlyEncrypted,
  description: "Pass --mac-only-encrypted when creating encrypted files",
});
editor.defineConfigBoolean("creationEnabled", {
  default: DEFAULTS.creationEnabled,
  description:
    "After saving a plaintext YAML/JSON/dotenv/INI file that a .sops.yaml creation rule matches, encrypt it in place",
});
editor.defineConfigInteger("autoSaveDelay", {
  default: DEFAULTS.autoSaveDelay,
  minimum: 0,
  maximum: 3600,
  description:
    "Encrypt and save decrypted buffers this many seconds after the last edit; 0 disables. Unsaved changes are otherwise lost when the editor quits",
});

/** Settings are read at the point of use, so changes apply without a reload. */
function settings(): Settings {
  const cfg = (editor.getPluginConfig() ?? {}) as Partial<Settings>;
  return { ...DEFAULTS, ...cfg };
}

function sopsFlags(): SopsFlags {
  const s = settings();
  return { ignoreMac: s.ignoreMac, macOnlyEncrypted: s.macOnlyEncrypted };
}

function isTrusted(): boolean {
  const level = editor.workspaceTrustLevel();
  return level === "" || level === "trusted";
}

function isRemote(): boolean {
  return editor.getAuthorityLabel() !== "";
}

/**
 * A file's text, or null when it cannot be read as text. `editor.readFile`
 * returns undefined rather than the documented null for some files (binary,
 * vanished since a restored session listed them), and may throw.
 */
function readText(path: string): string | null {
  try {
    const text = editor.readFile(path);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

function homeDir(): string {
  return editor.getEnv("HOME") ?? "";
}

function shown(path: string): string {
  return displayPath(path, editor.getCwd(), homeDir());
}

/** Settings, overridden by the project's .sopsrc when the workspace is trusted. */
function credentials(): Credentials {
  const s = settings();
  const cwd = editor.getCwd();
  const home = homeDir();
  const merged: Credentials = {
    ageKeyFile: s.ageKeyFile,
    awsProfile: s.awsProfile,
    gcpCredentialsPath: s.gcpCredentialsPath,
  };
  if (s.configPath !== "" && isTrusted()) {
    const rcPath = resolveUserPath(s.configPath, cwd, home);
    const text = editor.fileExists(rcPath) ? readText(rcPath) : null;
    if (text !== null) Object.assign(merged, parseRc(text));
  }
  return {
    ageKeyFile: merged.ageKeyFile ? resolveUserPath(merged.ageKeyFile, cwd, home) : "",
    awsProfile: merged.awsProfile ?? "",
    gcpCredentialsPath: merged.gcpCredentialsPath ? resolveUserPath(merged.gcpCredentialsPath, cwd, home) : "",
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type TokenState = "decrypted" | "unsaved" | "encrypting" | "encrypted";

/** A decrypted buffer and the encrypted file behind it. */
interface Session {
  bufferId: number;
  path: string;
  format: SopsFormat;
  /** The encrypted file as the plugin last read or wrote it; null until a new file is first saved. */
  cipherText: string | null;
  busy: boolean;
  pendingSave: boolean;
  /** When a debounced auto-save is due (ms since epoch), 0 when none. */
  autoSaveAt: number;
  /** Ciphertext already reported as changed on disk, so the warning is not repeated. */
  warnedCipher: string | null;
  /** Popups waiting on this buffer; dismissed when it closes. */
  popups: Set<string>;
  token: TokenState | null;
}

const sessions = new Map<number, Session>();
/** Encrypted file path → decrypted buffer. */
const byPath = new Map<string, number>();
/** Buffers deliberately showing an encrypted file as is → its path. */
const rawViews = new Map<number, string>();
/** Paths about to be opened as raw views by the toggle command. */
const openRaw = new Set<string>();
/** Paths being decrypted right now. */
const decrypting = new Set<string>();
/** Paths the plugin itself is rewriting; their open/revert/save events are its own. */
const suppressed = new Set<string>();
/** Edit counter and time of the last edit per buffer, fed by the edit hooks. */
const edits = new Map<number, { seq: number; at: number }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function t(key: string, args: Record<string, string> = {}): string {
  return editor.t(key, args);
}

function status(key: string, args: Record<string, string> = {}): void {
  editor.setStatus(t(key, args));
}

function setTokenFor(bufferId: number, state: TokenState): void {
  editor.setStatusBarValue(bufferId, STATUS_TOKEN, t(`token.${state}`));
}

function setToken(s: Session, state: TokenState): void {
  s.token = state;
  setTokenFor(s.bufferId, state);
}

/** Run a handler body so that no rejection escapes: one would stop every plugin. */
function guard(fn: () => Promise<void> | void): Promise<void> {
  try {
    return Promise.resolve(fn()).catch(internalError);
  } catch (e) {
    internalError(e);
    return Promise.resolve();
  }
}

function internalError(e: unknown): void {
  const detail = e instanceof Error ? e.message : String(e);
  editor.error(`sops plugin: ${e instanceof Error && e.stack ? e.stack : detail}`);
  status("error.internal", { detail });
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Parse errors can quote the offending line (sops' dotenv store does), and
 * status messages are logged to disk, so only messages known not to carry
 * content are shown.
 */
function safeContentError(detail: string): string {
  if (/^(yaml: |invalid character |unexpected end of JSON|json: )/.test(detail)) return detail;
  return "the document could not be parsed";
}

function reportFailure(op: string, path: string, failure: Failure, stderr: string): void {
  const args: Record<string, string> = { file: basename(path), op, bin: settings().binPath, detail: "" };
  let key: string;
  switch (failure.kind) {
    case "missing-binary":
      key = "error.missing_binary";
      break;
    case "no-key":
      key = "error.no_key";
      args.detail = truncate(failure.detail);
      break;
    case "mac-mismatch":
      key = "error.mac";
      break;
    case "invalid-content":
      key = "error.invalid";
      args.detail = truncate(safeContentError(failure.detail));
      break;
    case "no-creation-rule":
      key = "error.no_rule";
      break;
    case "no-config":
      key = "error.no_config";
      break;
    case "timeout":
      key = "error.timeout";
      break;
    case "already-encrypted":
      key = "error.already_encrypted";
      break;
    default:
      key = "error.other";
      args.detail = truncate(failure.detail);
  }
  status(key, args);
  // Key and config errors are worth the full text in the log; content errors may quote secrets.
  if (failure.kind !== "invalid-content" && stderr.trim() !== "") {
    editor.warn(`sops ${op} ${path}: ${stderr.trim()}`);
  }
}

interface RunResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a helper tool; never rejects. */
async function spawnQuiet(command: string, args: string[], cwd?: string): Promise<RunResult> {
  try {
    return await editor.spawnProcess(command, args, cwd).result;
  } catch (e) {
    return { exit_code: -1, stdout: "", stderr: String(e) };
  }
}

/** Run sops with the configured binary and credentials, killing it after the timeout. */
async function runSops(args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const inv = wrapSops(settings().binPath || "sops", { ...credentialEnv(credentials()), ...extraEnv }, args);
  const handle = editor.spawnProcess(inv.command, inv.args, cwd);
  const done: Promise<RunResult> = handle.result.then(
    (r) => r,
    (e) => ({ exit_code: -1, stdout: "", stderr: String(e) }),
  );
  const timedOut = Symbol("timeout");
  const first = await Promise.race([done, editor.delay(SOPS_TIMEOUT_MS).then(() => timedOut)]);
  if (first === timedOut) {
    try {
      await handle.kill();
    } catch {
      // Already gone.
    }
    return { exit_code: EXIT_TIMEOUT, stdout: "", stderr: "" };
  }
  return first as RunResult;
}

/** `sops decrypt` to stdout, retried without `.sops.yaml` if loading it fails (sops#884). */
async function decryptFile(path: string, format: SopsFormat): Promise<RunResult> {
  const r = await runSops(decryptArgs(format, path, sopsFlags()), dirname(path));
  if (r.exit_code !== 0 && classifyFailure(r.exit_code, r.stderr).kind === "config-error") {
    return await runSops(decryptArgs(format, path, { ...sopsFlags(), config: "/dev/null" }), dirname(path));
  }
  return r;
}

/** Places for private temporary directories, most private first. */
function tempBases(): string[] {
  const bases: string[] = [];
  const runtime = editor.getEnv("XDG_RUNTIME_DIR");
  if (runtime) bases.push(runtime);
  bases.push(editor.getTempDir());
  return bases;
}

/** A fresh directory only the user can enter (mktemp creates it 0700). */
async function makePrivateDir(): Promise<string | null> {
  for (const base of tempBases()) {
    const r = await spawnQuiet("mktemp", ["-d", joinPath(base, `${TEMP_PREFIX}XXXXXXXX`)]);
    const dir = r.stdout.trim();
    if (r.exit_code === 0 && dir !== "") return dir;
  }
  return null;
}

async function removePrivateDir(dir: string): Promise<void> {
  let removed = false;
  try {
    removed = editor.removePath(dir);
  } catch {
    removed = false;
  }
  // removePath only works under the OS temp dir; $XDG_RUNTIME_DIR is elsewhere.
  if (!removed) await spawnQuiet("rm", ["-rf", "--", dir]);
}

/** Remove temporary directories a crash left behind (a sops run takes at most minutes). */
async function removeStaleDirs(): Promise<void> {
  const user = editor.getEnv("USER");
  for (const base of tempBases()) {
    await spawnQuiet("find", [
      base,
      "-maxdepth",
      "1",
      "-type",
      "d",
      "-name",
      `${TEMP_PREFIX}*`,
      ...(user ? ["-user", user] : []),
      "-mmin",
      "+60",
      "-exec",
      "rm",
      "-rf",
      "{}",
      "+",
    ]);
  }
}

function lineNumbersEnabled(): boolean {
  const cfg = editor.getConfig() as { editor?: { line_numbers?: boolean } } | null;
  return cfg?.editor?.line_numbers ?? true;
}

/**
 * Syntax highlighting for a path the editor has no buffer for: the grammar
 * claiming its extension. Language ids are the lowercased grammar names
 * ("YAML" → "yaml"); extensions are listed without the dot.
 */
function languageForPath(path: string): string | null {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  for (const g of editor.listGrammars()) {
    if (g.file_extensions.some((e) => e.toLowerCase() === ext)) return g.name.toLowerCase();
  }
  return null;
}

/** Show a buffer, in the pane that already has it when there is one. */
function reveal(bufferId: number): void {
  const split = editor.getBufferInfo(bufferId)?.splits[0];
  if (split !== undefined) editor.focusSplit(split);
  editor.showBuffer(bufferId);
}

// ---------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------

let popupSeq = 0;
const popupWaiters = new Map<string, (actionId: string) => void>();

/** Show an action popup and wait for the choice ("dismissed" on Esc or when its buffer closes). */
function ask(
  s: Session | null,
  title: string,
  message: string,
  actions: { id: string; label: string }[],
): Promise<string> {
  const id = `sops-${++popupSeq}`;
  return new Promise<string>((resolve) => {
    popupWaiters.set(id, resolve);
    s?.popups.add(id);
    editor.showActionPopup({
      id,
      title,
      message,
      actions,
      ...(s ? { buffer_id: s.bufferId } : {}),
    });
  });
}

function resolvePopup(popupId: string, actionId: string): void {
  const waiter = popupWaiters.get(popupId);
  if (!waiter) return;
  popupWaiters.delete(popupId);
  for (const s of sessions.values()) s.popups.delete(popupId);
  waiter(actionId);
}

// ---------------------------------------------------------------------------
// Decrypted buffers
// ---------------------------------------------------------------------------

interface NewBuffer {
  path: string;
  format: SopsFormat;
  plaintext: string;
  cipherText: string | null;
  language: string | null;
  /** Pane to show the buffer in; without one it opens in the focused pane. */
  splitId?: number;
  /** Add the tab without switching to it. */
  background?: boolean;
  initialCursorLine?: number;
}

async function createDecryptedBuffer(o: NewBuffer): Promise<Session> {
  const others = [...byPath.keys()].filter((p) => p !== o.path);
  const res = await editor.createVirtualBuffer({
    name: decryptedBufferName(o.path, others),
    mode: MODE,
    readOnly: false,
    editingDisabled: false,
    showCursors: true,
    showLineNumbers: lineNumbersEnabled(),
    indentationGuide: true,
    entries: [{ text: o.plaintext }],
    ...(o.splitId !== undefined ? { splitId: o.splitId } : {}),
    ...(o.background ? { background: true } : {}),
    ...(o.initialCursorLine !== undefined ? { initialCursorLine: o.initialCursorLine } : {}),
  });
  const bufferId = res.bufferId;
  if (o.language) editor.setBufferLanguage(bufferId, o.language);
  const s: Session = {
    bufferId,
    path: o.path,
    format: o.format,
    cipherText: o.cipherText,
    busy: false,
    pendingSave: false,
    autoSaveAt: 0,
    warnedCipher: null,
    popups: new Set(),
    token: null,
  };
  sessions.set(bufferId, s);
  byPath.set(o.path, bufferId);
  setToken(s, "decrypted");
  return s;
}

interface EncryptedSource {
  /** The buffer showing the encrypted file, replaced by the decrypted one; null if none. */
  bufferId: number | null;
  path: string;
  format: SopsFormat;
  cipherText: string;
}

/** Decrypt a file into a new buffer that takes the place of its encrypted buffer. */
async function openDecrypted(src: EncryptedSource): Promise<void> {
  if (decrypting.has(src.path)) return;
  decrypting.add(src.path);
  try {
    status("status.decrypting", { file: basename(src.path) });
    const r = await decryptFile(src.path, src.format);
    if (r.exit_code !== 0) {
      reportFailure("decrypt", src.path, classifyFailure(r.exit_code, r.stderr), r.stderr);
      if (src.bufferId !== null) setTokenFor(src.bufferId, "encrypted");
      return;
    }
    if (src.format === "binary" && r.stdout.includes("\uFFFD")) {
      status("status.binary_content", { file: basename(src.path) });
      return;
    }
    const info = src.bufferId !== null ? editor.getBufferInfo(src.bufferId) : null;
    await createDecryptedBuffer({
      path: src.path,
      format: src.format,
      plaintext: r.stdout,
      cipherText: src.cipherText,
      language: info?.language ?? languageForPath(src.path),
      splitId: info?.splits[0],
      background: info !== null && info.splits.length === 0,
    });
    if (src.bufferId !== null) editor.closeBuffer(src.bufferId);
    status("status.decrypted", { file: basename(src.path) });
  } finally {
    decrypting.delete(src.path);
  }
}

/**
 * Replace a decrypted buffer with a fresh decryption of its file. A new buffer
 * rather than new content: the old undo history describes the old text.
 */
async function reloadSession(s: Session): Promise<void> {
  const disk = readText(s.path);
  if (disk === null) {
    status("status.missing", { file: basename(s.path) });
    return;
  }
  const format = detectSops(s.path, disk);
  if (format === null) {
    status("status.no_longer_encrypted", { file: basename(s.path) });
    return;
  }
  const r = await decryptFile(s.path, format);
  if (r.exit_code !== 0) {
    reportFailure("decrypt", s.path, classifyFailure(r.exit_code, r.stderr), r.stderr);
    return;
  }
  if (!sessions.has(s.bufferId)) return;
  const oldId = s.bufferId;
  const info = editor.getBufferInfo(oldId);
  const line = editor.getActiveBufferId() === oldId ? editor.getPrimaryCursor()?.line ?? undefined : undefined;
  await createDecryptedBuffer({
    path: s.path,
    format,
    plaintext: r.stdout,
    cipherText: disk,
    language: info?.language ?? languageForPath(s.path),
    splitId: info?.splits[0],
    background: info !== null && info.splits.length === 0,
    initialCursorLine: line,
  });
  forgetSession(s);
  editor.closeBuffer(oldId, true);
  status("status.reloaded", { file: basename(s.path) });
}

function forgetSession(s: Session): void {
  sessions.delete(s.bufferId);
  if (byPath.get(s.path) === s.bufferId) byPath.delete(s.path);
  edits.delete(s.bufferId);
  for (const id of [...s.popups]) resolvePopup(id, "dismissed");
}

/**
 * Clear the modified flag once the saved text is safely on disk, by writing
 * the same text back (the editor has no other way). Content edited since the
 * save read it stays modified. The rewrite waits for a pause in typing: a
 * keystroke landing between the final check and the rewrite would be lost.
 */
async function markClean(s: Session, savedText: string, seqAtRead: number): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const e = edits.get(s.bufferId);
    if ((e?.seq ?? 0) !== seqAtRead || !sessions.has(s.bufferId)) break;
    const idle = e === undefined ? QUIET_BEFORE_CLEAN_MS : Date.now() - e.at;
    if (idle < QUIET_BEFORE_CLEAN_MS) {
      await editor.delay(QUIET_BEFORE_CLEAN_MS - idle + 50);
      continue;
    }
    const current = await editor.getBufferText(s.bufferId);
    if (current !== savedText || (edits.get(s.bufferId)?.seq ?? 0) !== seqAtRead) break;
    const scroll = editor
      .listSplits()
      .filter((sp) => sp.bufferId === s.bufferId)
      .map((sp) => ({ splitId: sp.splitId, top: sp.viewport.topByte }));
    let rewritten = false;
    try {
      rewritten = editor.setVirtualBufferContent(s.bufferId, [{ text: savedText }]);
    } catch {
      rewritten = false;
    }
    if (!rewritten) break;
    for (const sc of scroll) editor.setSplitScroll(sc.splitId, sc.top);
    setToken(s, "decrypted");
    return;
  }
  if (sessions.has(s.bufferId)) setToken(s, "unsaved");
}

/** Encrypt and write a decrypted buffer. `auto` saves never ask questions. */
async function saveSession(s: Session, auto: boolean): Promise<void> {
  if (s.busy) {
    s.pendingSave = true;
    return;
  }
  s.busy = true;
  s.autoSaveAt = 0;
  setToken(s, "encrypting");
  let saved = false;
  try {
    const text = await editor.getBufferText(s.bufferId);
    const seqAtRead = edits.get(s.bufferId)?.seq ?? 0;
    saved = s.cipherText === null ? await createFile(s, text, auto) : await encryptExisting(s, text, auto);
    if (saved) await markClean(s, text, seqAtRead);
  } finally {
    s.busy = false;
    if (!saved && sessions.has(s.bufferId)) {
      setToken(s, editor.isBufferModified(s.bufferId) ? "unsaved" : "decrypted");
    }
    if (s.pendingSave && sessions.has(s.bufferId)) {
      s.pendingSave = false;
      void guard(() => saveSession(s, auto));
    }
  }
}

/** Write `text` to a private temp file and hand it to `fn`; the directory is removed afterwards. */
async function withPlaintextFile<T>(
  text: string,
  fn: (dir: string, plainPath: string) => Promise<T>,
): Promise<T | null> {
  const dir = await makePrivateDir();
  if (dir === null) {
    status("error.temp");
    return null;
  }
  try {
    const plainPath = joinPath(dir, "plain");
    if (!editor.writeFile(plainPath, text)) {
      status("error.temp");
      return null;
    }
    return await fn(dir, plainPath);
  } finally {
    await removePrivateDir(dir);
  }
}

async function encryptExisting(s: Session, text: string, auto: boolean): Promise<boolean> {
  const file = basename(s.path);
  const disk = readText(s.path);
  if (disk === null) {
    if (auto) {
      status("status.missing", { file });
      return false;
    }
    const choice = await ask(s, t("popup.missing_title"), t("popup.missing_msg", { file }), [
      { id: "create", label: t("popup.create") },
      { id: "cancel", label: t("popup.cancel") },
    ]);
    if (choice !== "create") {
      status("status.cancelled", { file });
      return false;
    }
    return await createFile(s, text, false);
  }
  if (disk !== s.cipherText) {
    if (auto) {
      status("status.auto_paused", { file });
      return false;
    }
    const choice = await ask(s, t("popup.conflict_title"), t("popup.conflict_msg", { file }), [
      { id: "overwrite", label: t("popup.overwrite") },
      { id: "reload", label: t("popup.reload") },
      { id: "cancel", label: t("popup.cancel") },
    ]);
    if (choice === "reload") {
      await reloadSession(s);
      return false;
    }
    if (choice !== "overwrite") {
      status("status.cancelled", { file });
      return false;
    }
  }

  status("status.encrypting", { file });
  const r = await withPlaintextFile(text, async (dir, plainPath) => {
    const cwd = dirname(s.path);
    let res = await runSops(
      editArgs(s.format, s.path, sopsFlags()),
      cwd,
      editEnv(plainPath, joinPath(dir, ".ran-1"), dir),
    );
    if (res.exit_code !== 0 && classifyFailure(res.exit_code, res.stderr).kind === "config-error") {
      const flags = { ...sopsFlags(), config: "/dev/null" };
      res = await runSops(editArgs(s.format, s.path, flags), cwd, editEnv(plainPath, joinPath(dir, ".ran-2"), dir));
    }
    return res;
  });
  if (r === null) return false;
  const failure = r.exit_code === 0 ? null : classifyFailure(r.exit_code, r.stderr);
  if (failure !== null && failure.kind !== "unchanged") {
    reportFailure("edit", s.path, failure, r.stderr);
    return false;
  }
  s.cipherText = readText(s.path);
  s.warnedCipher = null;
  status(failure === null ? "status.saved" : "status.unchanged", { file });
  return true;
}

/** First save of a new file: encrypt by the `.sops.yaml` creation rules for its path. */
async function createFile(s: Session, text: string, auto: boolean): Promise<boolean> {
  const file = basename(s.path);
  // Creating a file is a decision; an idle timer should not make it.
  if (auto) return false;
  if (editor.fileExists(s.path)) {
    status("status.exists", { file });
    return false;
  }
  status("status.encrypting", { file });
  const r = await withPlaintextFile(
    text,
    (dir, plainPath) =>
      runSops(encryptNewArgs(s.format, s.path, plainPath, sopsFlags()), dirname(s.path), { TMPDIR: dir }),
  );
  if (r === null) return false;
  if (r.exit_code !== 0) {
    reportFailure("encrypt", s.path, classifyFailure(r.exit_code, r.stderr), r.stderr);
    return false;
  }
  s.cipherText = readText(s.path);
  status("status.created", { file });
  return true;
}

/** Re-read the encrypted file when the buffer is looked at again, if it changed on disk. */
async function refreshFromDisk(s: Session): Promise<void> {
  if (s.busy || s.cipherText === null) return;
  const disk = readText(s.path);
  if (disk === null || disk === s.cipherText) return;
  if (!editor.isBufferModified(s.bufferId)) {
    await reloadSession(s);
    return;
  }
  if (s.warnedCipher !== disk) {
    s.warnedCipher = disk;
    status("status.changed_on_disk", { file: basename(s.path) });
  }
}

// ---------------------------------------------------------------------------
// Auto-save
// ---------------------------------------------------------------------------

let autoSaveTimer: number | null = null;

function scheduleAutoSave(s: Session): void {
  const delay = settings().autoSaveDelay;
  if (!(delay > 0) || s.cipherText === null) return;
  s.autoSaveAt = Date.now() + delay * 1000;
  if (autoSaveTimer === null) autoSaveTimer = editor.setInterval(1000, "sops_autosave_tick");
}

registerHandler("sops_autosave_tick", () =>
  guard(async () => {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      if (s.autoSaveAt === 0 || s.autoSaveAt > now || s.busy) continue;
      s.autoSaveAt = 0;
      if (editor.isBufferModified(s.bufferId)) await saveSession(s, true);
    }
    if (![...sessions.values()].some((s) => s.autoSaveAt !== 0) && autoSaveTimer !== null) {
      editor.clearInterval(autoSaveTimer);
      autoSaveTimer = null;
    }
  }));

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/** A file buffer appeared or was reloaded: decrypt it if it is a SOPS file. */
async function onFileOpened(bufferId: number, path: string): Promise<void> {
  if (rawViews.has(bufferId) || suppressed.has(path) || decrypting.has(path)) return;
  if (openRaw.delete(path)) {
    rawViews.set(bufferId, path);
    setTokenFor(bufferId, "encrypted");
    return;
  }
  const info = editor.getBufferInfo(bufferId);
  if (!info || info.is_virtual || info.is_terminal || info.path === "" || info.length > MAX_FILE_BYTES) return;

  const existing = byPath.get(path);
  if (existing !== undefined && sessions.has(existing)) {
    reveal(existing);
    editor.closeBuffer(bufferId);
    return;
  }
  const text = readText(path);
  if (text === null) return;
  const format = detectSops(path, text);
  if (format === null) return;
  setTokenFor(bufferId, "encrypted");

  const mode = settings().autoDecrypt;
  if (mode === "never") return;
  if (isRemote()) {
    status("status.remote");
    return;
  }
  if (mode === "trusted" && !isTrusted()) {
    status("status.restricted", { file: basename(path) });
    return;
  }
  await openDecrypted({ bufferId, path, format, cipherText: text });
}

async function onFileSaved(bufferId: number, path: string): Promise<void> {
  const s = sessions.get(bufferId);
  if (s) {
    // Only "Save As" writes a decrypted buffer to disk (Ctrl+S never does), and
    // it leaves an ordinary buffer of the new file, holding plaintext.
    forgetSession(s);
    await offerToEncryptCopy(bufferId, s.path, path);
    return;
  }
  if (rawViews.has(bufferId) || suppressed.has(path)) return;
  if (settings().creationEnabled && !isRemote()) await encryptOnCreation(bufferId, path);
}

async function offerToEncryptCopy(bufferId: number, source: string, dest: string): Promise<void> {
  const choice = await ask(
    null,
    t("popup.saveas_title"),
    t("popup.saveas_msg", { src: basename(source), dest: shown(dest) }),
    [
      { id: "encrypt", label: t("popup.encrypt_now") },
      { id: "keep", label: t("popup.keep") },
    ],
  );
  if (choice === "encrypt") {
    await encryptInPlaceAndOpen(bufferId, dest, false);
  } else {
    status("status.plaintext_kept", { file: shown(dest) });
  }
}

/** Nearest `.sops.yaml` in `dir` or above it. */
function findSopsConfig(dir: string): string | null {
  let d = dir;
  for (;;) {
    for (const name of [".sops.yaml", ".sops.yml"]) {
      const p = joinPath(d, name);
      if (editor.fileExists(p)) return p;
    }
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

/** `creationEnabled`: encrypt a freshly saved plaintext file a creation rule matches. */
async function encryptOnCreation(bufferId: number, path: string): Promise<void> {
  if (formatFromPath(path) === "binary") return;
  const name = basename(path);
  if (name === ".sops.yaml" || name === ".sops.yml") return;
  if (findSopsConfig(dirname(path)) === null) return;
  const text = readText(path);
  if (text === null || detectSops(path, text) !== null) return;
  await encryptInPlaceAndOpen(bufferId, path, true);
}

/**
 * Encrypt a plaintext file in place, then show it decrypted. `automatic` runs
 * (creationEnabled) stay silent when no creation rule covers the file.
 */
async function encryptInPlaceAndOpen(bufferId: number, path: string, automatic: boolean): Promise<void> {
  suppressed.add(path);
  try {
    if (!automatic) status("status.encrypting", { file: basename(path) });
    const r = await runSops(encryptInPlaceArgs(path, sopsFlags()), dirname(path));
    if (r.exit_code !== 0) {
      const failure = classifyFailure(r.exit_code, r.stderr);
      const noRule = failure.kind === "no-creation-rule" || failure.kind === "no-config";
      if (!(automatic && noRule)) reportFailure("encrypt", path, failure, r.stderr);
      return;
    }
    const cipher = readText(path);
    const format = cipher !== null ? detectSops(path, cipher) : null;
    if (cipher === null || format === null) return;
    status("status.encrypted_file", { file: basename(path) });
    await openDecrypted({ bufferId, path, format, cipherText: cipher });
  } finally {
    suppressed.delete(path);
  }
}

function onBufferClosed(bufferId: number): void {
  const s = sessions.get(bufferId);
  if (s) forgetSession(s);
  rawViews.delete(bufferId);
  edits.delete(bufferId);
}

async function onBufferActivated(bufferId: number): Promise<void> {
  const s = sessions.get(bufferId);
  if (s) {
    await refreshFromDisk(s);
    return;
  }
  if (rawViews.has(bufferId)) setTokenFor(bufferId, "encrypted");
}

function onEdited(bufferId: number): void {
  const s = sessions.get(bufferId);
  if (!s) return;
  const e = edits.get(bufferId);
  edits.set(bufferId, { seq: (e?.seq ?? 0) + 1, at: Date.now() });
  if (s.token !== "unsaved" && s.token !== "encrypting") setToken(s, "unsaved");
  scheduleAutoSave(s);
}

/**
 * Files opened before the plugin loaded (command line, restored session)
 * fired no after_file_open for it. Decrypted buffers need no such care: the
 * editor closes a plugin's virtual buffers when it unloads the plugin.
 */
async function sweep(): Promise<void> {
  for (const b of editor.listBuffers()) {
    if (!b.is_virtual && !b.is_terminal && typeof b.path === "string" && b.path !== "") {
      await onFileOpened(b.id, b.path);
    }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function saveActive(): Promise<void> {
  const id = editor.getActiveBufferId();
  const s = sessions.get(id);
  if (!s) {
    // A buffer "Save As" turned into a file keeps the mode that binds Ctrl+S here.
    const info = editor.getBufferInfo(id);
    if (info && !info.is_virtual && info.path !== "") {
      editor.executeAction("save");
    } else {
      status("status.not_sops_buffer");
    }
    return;
  }
  if (s.cipherText !== null && !s.busy && !editor.isBufferModified(s.bufferId)) {
    status("status.unchanged", { file: basename(s.path) });
    return;
  }
  await saveSession(s, false);
}

async function reloadActive(): Promise<void> {
  const s = sessions.get(editor.getActiveBufferId());
  if (!s) {
    status("status.not_sops_buffer");
    return;
  }
  if (s.cipherText === null) {
    status("status.not_saved_yet", { file: basename(s.path) });
    return;
  }
  if (s.busy) return;
  await reloadSession(s);
}

async function decryptActive(): Promise<void> {
  const id = editor.getActiveBufferId();
  const s = sessions.get(id);
  if (s) {
    status("status.already_decrypted", { file: basename(s.path) });
    return;
  }
  const info = editor.getBufferInfo(id);
  if (!info || info.is_virtual || info.path === "") {
    status("status.no_file");
    return;
  }
  if (isRemote()) {
    status("status.remote");
    return;
  }
  const existing = byPath.get(info.path);
  if (existing !== undefined) {
    reveal(existing);
    return;
  }
  const text = readText(info.path);
  const format = text !== null ? detectSops(info.path, text) : null;
  if (text === null || format === null) {
    status("status.not_sops", { file: basename(info.path) });
    return;
  }
  rawViews.delete(id);
  await openDecrypted({ bufferId: id, path: info.path, format, cipherText: text });
}

async function toggleActive(): Promise<void> {
  const id = editor.getActiveBufferId();
  const s = sessions.get(id);
  if (s) {
    if (s.cipherText === null) {
      status("status.not_saved_yet", { file: basename(s.path) });
      return;
    }
    for (const [rawId, rawPath] of rawViews) {
      if (rawPath === s.path) {
        reveal(rawId);
        return;
      }
    }
    const open = editor.findBufferByPath(s.path);
    if (open !== 0) {
      rawViews.set(open, s.path);
      reveal(open);
      return;
    }
    openRaw.add(s.path);
    if (!editor.openFile(s.path)) openRaw.delete(s.path);
    return;
  }
  const path = rawViews.get(id) ?? editor.getBufferInfo(id)?.path ?? "";
  const decrypted = path !== "" ? byPath.get(path) : undefined;
  if (decrypted !== undefined) {
    reveal(decrypted);
    return;
  }
  await decryptActive();
}

async function encryptActiveFile(): Promise<void> {
  const id = editor.getActiveBufferId();
  if (sessions.has(id)) {
    status("status.already_encrypted", { file: basename(sessions.get(id)!.path) });
    return;
  }
  const info = editor.getBufferInfo(id);
  if (!info || info.is_virtual || info.path === "") {
    status("status.no_file");
    return;
  }
  if (isRemote()) {
    status("status.remote");
    return;
  }
  const file = basename(info.path);
  if (info.modified) {
    status("status.save_first", { file });
    return;
  }
  const text = readText(info.path);
  if (text === null) {
    status("status.no_file");
    return;
  }
  if (detectSops(info.path, text) !== null) {
    status("status.already_encrypted", { file });
    return;
  }
  await encryptInPlaceAndOpen(id, info.path, false);
}

async function newEncryptedFile(): Promise<void> {
  if (isRemote()) {
    status("status.remote");
    return;
  }
  const activePath = editor.getBufferInfo(editor.getActiveBufferId())?.path ?? "";
  const startDir = activePath !== "" && !byPath.has(activePath) ? dirname(activePath) : editor.getCwd();
  const input = await editor.prompt(t("prompt.new_file"), `${startDir.replace(/\/+$/, "")}/`);
  if (input === null || input.trim() === "" || input.trim().endsWith("/")) return;
  const path = resolveUserPath(input, editor.getCwd(), homeDir());
  const file = basename(path);
  const existing = byPath.get(path);
  if (existing !== undefined) {
    reveal(existing);
    return;
  }
  if (editor.fileExists(path)) {
    status("status.exists", { file });
    editor.openFile(path);
    return;
  }
  if (!editor.fileExists(dirname(path))) {
    status("status.no_dir", { dir: shown(dirname(path)) });
    return;
  }
  await createDecryptedBuffer({
    path,
    format: formatFromPath(path),
    plaintext: "",
    cipherText: null,
    language: languageForPath(path),
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

editor.defineMode(MODE, [["C-s", "sops_save"]], false, false, true);
editor.registerStatusBarElement(STATUS_TOKEN, t("statusbar.title"));

registerHandler("sops_save", () => guard(saveActive));
registerHandler("sops_reload", () => guard(reloadActive));
registerHandler("sops_decrypt", () => guard(decryptActive));
registerHandler("sops_toggle", () => guard(toggleActive));
registerHandler("sops_encrypt_file", () => guard(encryptActiveFile));
registerHandler("sops_new_file", () => guard(newEncryptedFile));

// Save and reload only apply to decrypted buffers, whose mode is MODE.
editor.registerCommand("%cmd.save", "%cmd.save_desc", "sops_save", MODE);
editor.registerCommand("%cmd.reload", "%cmd.reload_desc", "sops_reload", MODE);
editor.registerCommand("%cmd.decrypt", "%cmd.decrypt_desc", "sops_decrypt", null);
editor.registerCommand("%cmd.toggle", "%cmd.toggle_desc", "sops_toggle", null);
editor.registerCommand("%cmd.encrypt_file", "%cmd.encrypt_file_desc", "sops_encrypt_file", null);
editor.registerCommand("%cmd.new_file", "%cmd.new_file_desc", "sops_new_file", null);

editor.on("after_file_open", (a) => guard(() => onFileOpened(a.buffer_id, a.path)));
editor.on("after_file_revert", (a) => guard(() => onFileOpened(a.buffer_id, a.path)));
editor.on("after_file_save", (a) => guard(() => onFileSaved(a.buffer_id, a.path)));
editor.on("buffer_closed", (a) => onBufferClosed(a.buffer_id));
editor.on("buffer_activated", (a) => guard(() => onBufferActivated(a.buffer_id)));
editor.on("focus_gained", () => guard(() => onBufferActivated(editor.getActiveBufferId())));
editor.on("after_insert", (a) => onEdited(a.buffer_id));
editor.on("after_delete", (a) => onEdited(a.buffer_id));
editor.on("action_popup_result", (a) => resolvePopup(a.popup_id, a.action_id));
editor.on("plugins_loaded", () => guard(sweep));

void guard(sweep);
void guard(removeStaleDirs);
