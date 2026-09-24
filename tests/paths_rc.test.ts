import { basename, decryptedBufferName, dirname, displayPath, normalize, resolveUserPath } from "../lib/paths.ts";
import { parseRc } from "../lib/rc.ts";
import { assertEquals } from "./assert.ts";

Deno.test("basename and dirname", () => {
  assertEquals(basename("/a/b/c.yaml"), "c.yaml");
  assertEquals(basename("c.yaml"), "c.yaml");
  assertEquals(dirname("/a/b/c.yaml"), "/a/b");
  assertEquals(dirname("/c.yaml"), "/");
  assertEquals(dirname("c.yaml"), ".");
});

Deno.test("resolveUserPath: home, relative, absolute", () => {
  assertEquals(resolveUserPath("~/keys/age.txt", "/proj", "/home/u"), "/home/u/keys/age.txt");
  assertEquals(resolveUserPath("~", "/proj", "/home/u"), "/home/u");
  assertEquals(resolveUserPath("./.sopsrc", "/proj", "/home/u"), "/proj/.sopsrc");
  assertEquals(resolveUserPath("../x/y.yaml", "/proj/sub", "/home/u"), "/proj/x/y.yaml");
  assertEquals(resolveUserPath("  /etc//sops/./k  ", "/proj", "/home/u"), "/etc/sops/k");
  assertEquals(normalize("a/../../b"), "../b");
});

Deno.test("displayPath shortens below the workspace and home", () => {
  assertEquals(displayPath("/proj/a/s.yaml", "/proj", "/home/u"), "a/s.yaml");
  assertEquals(displayPath("/proj/a/s.yaml", "/proj/", "/home/u"), "a/s.yaml");
  assertEquals(displayPath("/home/u/k/s.yaml", "/proj", "/home/u"), "~/k/s.yaml");
  assertEquals(displayPath("/projector/s.yaml", "/proj", "/home/u"), "/projector/s.yaml");
  assertEquals(displayPath("/etc/s.yaml", "/proj", ""), "/etc/s.yaml");
});

Deno.test("decrypted buffer names get the parent directory only on a clash", () => {
  assertEquals(decryptedBufferName("/c/prod/secret.yaml", []), "secret.yaml [sops]");
  assertEquals(decryptedBufferName("/c/prod/secret.yaml", ["/c/dev/app.env"]), "secret.yaml [sops]");
  assertEquals(decryptedBufferName("/c/prod/secret.yaml", ["/c/dev/secret.yaml"]), "prod/secret.yaml [sops]");
});

Deno.test("parseRc reads the credential keys and nothing else", () => {
  const rc = [
    "# project defaults",
    "awsProfile: my-profile-1",
    'gcpCredentialsPath: "/home/user/Downloads/my key.json"',
    "ageKeyFile: ~/age.txt  # comment",
    "binPath: /evil/sops",
    "  nested: ignored",
    "",
  ].join("\n");
  assertEquals(parseRc(rc), {
    awsProfile: "my-profile-1",
    gcpCredentialsPath: "/home/user/Downloads/my key.json",
    ageKeyFile: "~/age.txt",
  });
  assertEquals(parseRc("ageKeyFile: ''\n"), {});
});
