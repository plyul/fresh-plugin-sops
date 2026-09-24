import { detectSops, formatFromPath } from "../lib/detect.ts";
import { assertEquals } from "./assert.ts";

// Fixtures are real sops 3.13 output, encrypted to a throwaway age key.
const fixture = (name: string) => Deno.readTextFileSync(new URL(`./fixtures/${name}`, import.meta.url));

Deno.test("formatFromPath follows the sops CLI suffix rules", () => {
  assertEquals(formatFromPath("/a/secret.yaml"), "yaml");
  assertEquals(formatFromPath("/a/secret.yml"), "yaml");
  assertEquals(formatFromPath("/a/app.json"), "json");
  assertEquals(formatFromPath("/a/.env"), "dotenv");
  assertEquals(formatFromPath("/a/prod.env"), "dotenv");
  assertEquals(formatFromPath("/a/.env.prod"), "binary");
  assertEquals(formatFromPath("/a/conf.ini"), "ini");
  assertEquals(formatFromPath("/a/SECRET.YAML"), "binary");
  assertEquals(formatFromPath("/a/key.pem"), "binary");
});

Deno.test("detects every sops store by content", () => {
  assertEquals(detectSops("/p/secret.yaml", fixture("secret.enc.yaml")), "yaml");
  assertEquals(detectSops("/p/app.env", fixture("app.enc.env")), "dotenv");
  assertEquals(detectSops("/p/conf.ini", fixture("conf.enc.ini")), "ini");
  assertEquals(detectSops("/p/app.json", fixture("app.enc.json")), "json");
  assertEquals(detectSops("/p/note.txt", fixture("note.enc.txt")), "binary");
});

Deno.test("content wins over a misleading file name", () => {
  // Encrypted with an explicit --input-type, or renamed afterwards.
  assertEquals(detectSops("/p/secret.yaml.enc", fixture("secret.enc.yaml")), "yaml");
  assertEquals(detectSops("/p/.env.production", fixture("app.enc.env")), "dotenv");
  assertEquals(detectSops("/p/settings.conf", fixture("conf.enc.ini")), "ini");
  assertEquals(detectSops("/p/data", fixture("app.enc.json")), "json");
});

Deno.test("the binary wrapper under a .json name reads as JSON, as the sops CLI would", () => {
  assertEquals(detectSops("/p/note.json", fixture("note.enc.txt")), "json");
});

Deno.test("plain files and look-alikes are not sops files", () => {
  assertEquals(detectSops("/p/plain.yaml", fixture("plain.yaml")), null);
  assertEquals(detectSops("/p/lookalike.yaml", fixture("lookalike.yaml")), null);
  assertEquals(detectSops("/p/lookalike.json", fixture("lookalike.json")), null);
  assertEquals(detectSops("/p/empty.yaml", ""), null);
  // editor.readFile can return undefined instead of null.
  assertEquals(detectSops("/p/unreadable.bin", undefined as unknown as string), null);
  assertEquals(detectSops("/p/broken.json", "{not json"), null);
  assertEquals(detectSops("/p/list.json", '[{"sops": {"mac": "x", "version": "3", "lastmodified": "y"}}]'), null);
});

Deno.test("yaml: the sops block must be top-level", () => {
  const nested = "outer:\n  sops:\n    mac: x\n    version: 3.13.1\n    lastmodified: now\n";
  assertEquals(detectSops("/p/n.yaml", nested), null);
  const crlf = fixture("secret.enc.yaml").replace(/\n/g, "\r\n");
  assertEquals(detectSops("/p/crlf.yaml", crlf), "yaml");
});

Deno.test("ini: metadata keys must be inside the [sops] section", () => {
  const text = "[sops]\nversion = 3\n[other]\nmac = x\nlastmodified = y\n";
  assertEquals(detectSops("/p/x.ini", text), null);
});
