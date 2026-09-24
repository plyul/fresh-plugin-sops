# SOPS for Fresh

## AI Disclaimer

This plugin was written with an AI coding assistant. The author set the requirements and made the design decisions;
the assistant researched the Fresh plugin API and sources, wrote the code, tests and this README, and ran the tests.
It is covered by unit tests and by end-to-end tests that drive a real Fresh instance, but it has not had an
independent human code review.

The plugin handles secrets. Read the [Security](#security) and [Limitations](#limitations) sections, review the code
yourself before relying on it, and keep your encrypted files under version control so a mistake can be undone.

## Summary

Edit [SOPS](https://github.com/getsops/sops)-encrypted files in the [Fresh](https://getfresh.dev) editor as if they were
plain text: opening an encrypted file shows its decrypted content, and saving writes it back encrypted.

**The plaintext stays in the editor's memory**: no decrypted copy is ever written next to the original.

## How it works

- Opening a SOPS-encrypted YAML, JSON, dotenv, INI or binary file replaces its tab with an in-memory buffer named
  `<file> [sops]`, holding what `sops decrypt` returns. Files are recognised by their content, so names like
  `secret.yaml.enc` or `.env.production` work too.
- **Ctrl+S** in that buffer re-encrypts the file through `sops edit`. The data key, key groups (age, PGP, KMS, Vault…),
  `encrypted_regex` and the rest of the metadata stay as they were: the result is what the sops CLI would write.
- The plaintext never lives in a file-backed buffer, so Fresh's crash recovery, hot exit, session restore and language
  servers never see it. It reaches the disk only briefly while sops runs (see [Security](#security)).

## Requirements

- Fresh 0.5.1 or newer.
- sops 3.9 or newer on `PATH` (or set `binPath`), plus what your keys need: age, gpg, cloud credentials.
- Linux or macOS: the plugin runs sops through `sh`, `env` and `mktemp`.

## Installation

Link a checkout into Fresh's package directory, so updating the checkout updates the plugin:

```sh
git clone <this repository> ~/src/fresh-plugin-sops
ln -s ~/src/fresh-plugin-sops ~/.config/fresh/plugins/packages/sops
```

or run **pkg: Install from URL** with the repository URL. Restart Fresh afterwards.

## Usage

Open an encrypted file the usual way: file explorer, Quick Open, or `fresh secrets.yaml`. Edit, then press **Ctrl+S**.

| Command                                | What it does                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| SOPS: Encrypt and Save                 | Same as Ctrl+S in a decrypted buffer                                                 |
| SOPS: Reload from Encrypted File       | Discard unsaved changes and decrypt again                                            |
| SOPS: Decrypt Current File             | Decrypt by hand (restricted workspace, `autoDecrypt: "never"`, after an error)       |
| SOPS: Toggle Encrypted/Decrypted View  | Look at the file as it is stored, and back                                           |
| SOPS: Encrypt Current File             | Encrypt the current plaintext file in place by the `.sops.yaml` creation rules       |
| SOPS: New Encrypted File…              | Create a new encrypted file; its plaintext never touches the disk                    |

- **Changed on disk.** If the encrypted file changed after it was decrypted (a `git pull`, another editor), Ctrl+S asks
  whether to overwrite it or discard your changes and reload. An unmodified decrypted buffer reloads by itself when you
  switch back to it.
- **Errors** are reported in the status line: invalid YAML/JSON (the file is left untouched and the parser's message is
  shown), no usable key, MAC mismatch, sops missing. Full sops output goes to Fresh's warnings log.
- **Status bar.** Add `{sops:status}` to `editor.status_bar.left` or `.right` to see `sops: decrypted`, `sops: unsaved`,
  `sops: encrypting…` or `sops: encrypted` for the current buffer.

## Settings

Under **Settings → Plugins → sops**, or in `config.json`:

```json
{
  "plugins": {
    "sops": {
      "settings": {
        "ageKeyFile": "~/.config/sops/age/keys.txt",
        "autoSaveDelay": 30
      }
    }
  }
}
```

| Setting              | Default     | Meaning                                                                                    |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| `autoDecrypt`        | `"trusted"` | Decrypt on open: only in trusted workspaces, `"always"`, or `"never"`                      |
| `binPath`            | `"sops"`    | sops executable                                                                            |
| `ageKeyFile`         | `""`        | Passed as `SOPS_AGE_KEY_FILE`                                                              |
| `awsProfile`         | `""`        | Passed as `AWS_PROFILE`                                                                    |
| `gcpCredentialsPath` | `""`        | Passed as `GOOGLE_APPLICATION_CREDENTIALS`                                                 |
| `configPath`         | `".sopsrc"` | Project file overriding the three above (see below); `""` disables it                     |
| `ignoreMac`          | `false`     | `--ignore-mac` when decrypting and saving                                                  |
| `macOnlyEncrypted`   | `false`     | `--mac-only-encrypted` when creating encrypted files                                       |
| `creationEnabled`    | `false`     | Encrypt a plaintext YAML/JSON/dotenv/INI file in place when it is saved and a creation rule matches it |
| `autoSaveDelay`      | `0`         | Encrypt and save decrypted buffers this many seconds after the last edit; `0` disables     |

Empty values leave sops to its usual environment variables and defaults. Paths may start with `~/` and are otherwise
relative to the workspace.

### `.sopsrc`

A YAML file at the workspace root can set credentials per project:

```yaml
awsProfile: my-profile-1
gcpCredentialsPath: /home/user/Downloads/my-key.json
ageKeyFile: /home/user/age.txt
```

It is read only in trusted workspaces.

## Security

- The plaintext lives in the editor's memory: the decrypted buffer and the plugin runtime.
- While sops encrypts, the plaintext is written to a file in a new `0700` directory created by `mktemp` in
  `$XDG_RUNTIME_DIR` (a per-user tmpfs on systemd Linux), or in the system temp directory without one. sops' own
  temporary file goes into the same directory, which is deleted as soon as sops exits. Directories a crash left behind
  are removed at the next start once they are an hour old.
- The plaintext is never put in process arguments, which other users can read with `ps`. Status and log messages never
  quote it; parse errors are shown without the offending line.
- **Workspace Trust.** An encrypted file's metadata tells sops which key services to contact, so by default files are
  decrypted automatically only in trusted workspaces. In a restricted one, run **SOPS: Decrypt Current File**.

## Limitations

Read these before relying on the plugin:

- **Unsaved changes in decrypted buffers are discarded without a prompt** when Fresh quits, and when the plugin is
  disabled or reloaded. Fresh leaves in-memory buffers out of its unsaved-changes prompt and closes a plugin's buffers
  when it unloads the plugin. Save with Ctrl+S, or set `autoSaveDelay`.
- **Only Ctrl+S (or "SOPS: Encrypt and Save") encrypts.** File → Save, the palette's "Save", and the `(s)ave` answer when
  closing a modified decrypted tab all open Fresh's "Save As", which writes plaintext. If it happens, the plugin notices
  and offers to encrypt the new file in place. When closing a modified decrypted tab, answer `(C)ancel` and press Ctrl+S,
  or `(d)iscard`.
- Decrypted buffers use their own buffer mode to take over Ctrl+S, so a global mode such as vi-mode does not apply in
  them.
- For PGP keys with a passphrase, use a graphical pinentry or unlock gpg-agent beforehand: a terminal pinentry would
  compete with the editor for the terminal.
- Binary files open only if their content is text. Remote sessions (SSH, devcontainers) and Windows are not supported.

## Git diffs of encrypted files

To let git show decrypted diffs, add to `.gitattributes`:

```
*.enc.yaml diff=sopsdiffer
```

and once, globally:

```sh
git config --global diff.sopsdiffer.textconv "sops decrypt"
```

## Development

```sh
deno task types   # copy fresh.d.ts from the local Fresh install into types/
deno task check   # type-check
deno task test    # unit tests
deno task e2e     # end-to-end tests
```

The end-to-end tests start a throwaway Fresh inside a private tmux server with its own XDG directories and a
disposable age key. They never touch your configuration or running editors. Besides `fresh` and `sops` they need
`age-keygen`, `tmux` and `jq`. Set `KEEP=1` to keep the work directory for inspection.

`sops.ts` holds the editor integration; `lib/` holds pure functions (format detection, sops command lines, error
parsing) that the unit tests cover.

## License

MIT
