import {
  classifyFailure,
  credentialEnv,
  decryptArgs,
  editArgs,
  editEnv,
  encryptInPlaceArgs,
  encryptNewArgs,
  FAKE_EDITOR,
  firstLine,
  wrapSops,
} from "../lib/cli.ts";
import { assert, assertEquals } from "./assert.ts";

const flags = { ignoreMac: false, macOnlyEncrypted: false };

Deno.test("wrapSops: stdin from /dev/null, env via env(1), no shell parsing of values", () => {
  const inv = wrapSops("sops", { SOPS_AGE_KEY_FILE: "/k/my key.txt", EMPTY: "" }, ["decrypt", "/p/a b.yaml"]);
  assertEquals(inv.command, "sh");
  assertEquals(inv.args, [
    "-c",
    'exec "$@" </dev/null',
    "fresh-sops",
    "env",
    "SOPS_AGE_KEY_FILE=/k/my key.txt",
    "sops",
    "decrypt",
    "/p/a b.yaml",
  ]);
});

Deno.test("argument lists: global flags before the subcommand, the file last", () => {
  assertEquals(decryptArgs("yaml", "/p/s.yaml", flags), [
    "decrypt",
    "--input-type",
    "yaml",
    "--output-type",
    "yaml",
    "/p/s.yaml",
  ]);
  assertEquals(editArgs("dotenv", "/p/.env", { ...flags, ignoreMac: true, config: "/dev/null" }), [
    "--config",
    "/dev/null",
    "edit",
    "--input-type",
    "dotenv",
    "--output-type",
    "dotenv",
    "--ignore-mac",
    "/p/.env",
  ]);
  assertEquals(encryptInPlaceArgs("/p/s.yaml", { ...flags, macOnlyEncrypted: true }), [
    "--mac-only-encrypted",
    "encrypt",
    "--in-place",
    "/p/s.yaml",
  ]);
  assertEquals(encryptNewArgs("json", "/p/n.json", "/tmp/x/plain", flags), [
    "encrypt",
    "--filename-override",
    "/p/n.json",
    "--input-type",
    "json",
    "--output-type",
    "json",
    "--output",
    "/p/n.json",
    "/tmp/x/plain",
  ]);
});

Deno.test("--mac-only-encrypted never reaches decrypt or edit", () => {
  const f = { ...flags, macOnlyEncrypted: true };
  assert(!decryptArgs("yaml", "/p", f).includes("--mac-only-encrypted"));
  assert(!editArgs("yaml", "/p", f).includes("--mac-only-encrypted"));
});

Deno.test("fake editor gets its paths from the environment only", () => {
  const env = editEnv("/run/d/plain", "/run/d/.ran-1", "/run/d");
  assertEquals(env.SOPS_EDITOR, FAKE_EDITOR);
  assertEquals(env.FRESH_SOPS_SRC, "/run/d/plain");
  assertEquals(env.FRESH_SOPS_MARKER, "/run/d/.ran-1");
  assertEquals(env.TMPDIR, "/run/d");
  assert(!FAKE_EDITOR.includes("/run/d"), "no paths inside the shlex-split command");
});

Deno.test("credentialEnv maps settings to sops environment variables", () => {
  assertEquals(credentialEnv({}), {});
  assertEquals(credentialEnv({ ageKeyFile: "/k", awsProfile: "prod", gcpCredentialsPath: "/g.json" }), {
    SOPS_AGE_KEY_FILE: "/k",
    AWS_PROFILE: "prod",
    GOOGLE_APPLICATION_CREDENTIALS: "/g.json",
  });
});

// stderr samples below are verbatim sops 3.13.1 output.

Deno.test("classify: parse error from the edit loop keeps the parser message", () => {
  const stderr = `[CMD]\t time="2026-09-23T19:36:52+05:00" level=error msg="Could not load tree, probably due to ` +
    `invalid syntax. Press enter to return to the editor, or Ctrl+C to exit." error="yaml: line 1: did not ` +
    `find expected ',' or ']'"\nCould not run editor: exit status 3\n`;
  assertEquals(classifyFailure(201, stderr), {
    kind: "invalid-content",
    detail: "yaml: line 1: did not find expected ',' or ']'",
  });
});

Deno.test("classify: unchanged, missing binary, timeout", () => {
  assertEquals(classifyFailure(200, "File has not changed, exiting.\n").kind, "unchanged");
  assertEquals(classifyFailure(127, "env: ‘sops’: No such file or directory\n").kind, "missing-binary");
  assertEquals(classifyFailure(127, "env: «/opt/sops»: Нет такого файла или каталога\n").kind, "missing-binary");
  assertEquals(classifyFailure(126, "env: ‘/opt/sops’: Permission denied\n").kind, "missing-binary");
  assertEquals(classifyFailure(-1, "Process error: No such file or directory (os error 2)").kind, "missing-binary");
  assertEquals(classifyFailure(-2, "").kind, "timeout");
});

Deno.test("classify: no usable key, with the per-key reason", () => {
  const stderr = `Failed to get the data key required to decrypt the SOPS file.

Group 0: FAILED
  age1ur2jzf80x9h00qkcgsnqv5zmemlzqj7w3p88tpt399t4e2nrm3wqat696f: FAILED
    - | failed to create reader for decrypting sops data key with
      | age: no identity matched any of the recipients. Did not find
      | keys in locations 'SOPS_AGE_SSH_PRIVATE_KEY_FILE',
      | 'SOPS_AGE_SSH_PRIVATE_KEY_CMD', 'SOPS_AGE_KEY', and
      | 'SOPS_AGE_KEY_CMD'.

Recovery failed because no master key was able to decrypt the file. In
order for SOPS to recover the file, at least one key has to be successful,
but none were.
`;
  const f = classifyFailure(128, stderr);
  assertEquals(f.kind, "no-key");
  assert(f.detail.startsWith("failed to create reader for decrypting sops data key with age: no identity matched"));
});

Deno.test("classify: creation rules and config", () => {
  assertEquals(classifyFailure(1, "error loading config: no matching creation rules found\n").kind, "no-creation-rule");
  assertEquals(
    classifyFailure(
      1,
      "config file not found, or has no creation rules, and no keys provided through command line options\n",
    ).kind,
    "no-config",
  );
  assertEquals(classifyFailure(5, "error loading config: yaml: unmarshal errors\n").kind, "config-error");
});

Deno.test("classify: MAC mismatch and anything else", () => {
  assertEquals(classifyFailure(51, "Error decrypting tree: MAC mismatch\n").kind, "mac-mismatch");
  assertEquals(classifyFailure(1, "\n  something odd happened\nmore\n"), {
    kind: "other",
    detail: "something odd happened",
  });
  assertEquals(classifyFailure(9, ""), { kind: "other", detail: "exit code 9" });
});

Deno.test("firstLine strips the logrus prefix", () => {
  assertEquals(
    firstLine(`[CMD]\t time="t" level=warning msg="More than one positional argument \\"x\\" provided."`),
    'More than one positional argument "x" provided.',
  );
});
