#!/usr/bin/env bash
# End-to-end tests of the SOPS plugin in a throwaway editor (see lib.sh).
#   bash tests/e2e/run.sh          run everything
#   KEEP=1 bash tests/e2e/run.sh   keep the work dir for inspection
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Open a SOPS file and wait for its decrypted buffer; prints the buffer as JSON.
open_decrypted() { # open_decrypted <relative path> <buffer name>
  fx <<EOF
editor.openFile(P("$1"));
const v = await until(() => vbuf("$2"));
if (!v) return { id: null };
await editor.delay(200);
const b = vbuf("$2");
return { id: b.id, language: b.language, modified: b.modified, raw: fbuf(P("$1")) !== null,
         active: editor.getActiveBufferId() === b.id, text: await editor.getBufferText(b.id) };
EOF
}

buffer_text() { fx <<<"return await editor.getBufferText($1);" | jq -r .; }
is_modified() { fx <<<"return editor.getBufferInfo($1)?.modified ?? null;"; }
vbuf_id() { fx <<<"return vbuf(\"$1\")?.id ?? null;"; }
append() { # append <buffer id> <text>
  fx <<EOF >/dev/null
editor.insertText($1, editor.getBufferLength($1), $(jq -Rn --arg t "$2" '$t'));
await editor.delay(150);
return true;
EOF
}
run_command() { fx <<<"return await editor.runCommand($(jq -Rn --arg c "$1" '$c'));" >/dev/null; }
set_setting() { fx <<<"return editor.setSetting(\"plugins.sops.settings.$1\", $2);" >/dev/null; sleep 0.3; }
no_private_dirs() { ! find "$RUN" -maxdepth 1 -name 'fresh-sops.*' | grep -q .; }
no_sops_running() { ! pgrep -x sops >/dev/null; }
sha() { sha256sum <"$PROJ/$1"; }
mark_status() { STATUS_MARK=$(status_log | wc -l); }
new_status() { status_log | tail -n +"$((STATUS_MARK + 1))"; }
wait_new_status() { # wait_new_status <regex>: a status line after the last mark_status
  local i
  for i in $(seq 1 100); do
    new_status | grep -qE -- "$1" && return 0
    sleep 0.2
  done
  echo "       status since mark:" >&2
  new_status | sed 's/^/         /' >&2
  return 1
}

section "setup"
setup_project
setup_editor
start_editor
ok "isolated editor started"

section "opening an encrypted file"
r=$(open_decrypted secret.yaml "secret.yaml [sops]")
V=$(jq -r .id <<<"$r")
check "a decrypted buffer appears" [ "$V" != null ]
check "it replaces the encrypted file's tab" [ "$(jq -r .raw <<<"$r")" = false ]
check "it is the active buffer" [ "$(jq -r .active <<<"$r")" = true ]
check "it holds exactly what sops decrypts" [ "$(jq -r .text <<<"$r")" = "$(decrypted secret.yaml)" ]
check "it is highlighted as YAML" [ "$(jq -r .language <<<"$r")" = yaml ]
check "it starts unmodified" [ "$(jq -r .modified <<<"$r")" = false ]
check "the tab says it is a SOPS buffer" screen_has "secret.yaml \[sops\] ×"

section "editing and saving with Ctrl+S"
keys C-End
type_text "    extra: ex-$MARKER"
sleep 0.3
check "typing marks the buffer modified" [ "$(is_modified "$V")" = true ]
mark_status
keys C-s
check "Ctrl+S encrypts and saves" wait_new_status "secret.yaml encrypted and saved"
check "the file decrypts to the edited text" grep -q "extra: ex-$MARKER" <(decrypted secret.yaml)
check "the new value is encrypted on disk" [ "$(grep -c "$MARKER" "$PROJ/secret.yaml")" = 0 ]
check "recipients and encrypted_regex are kept" grep -q "encrypted_regex: \^(data|stringData|password|token)\\$" "$PROJ/secret.yaml"
check "the buffer is clean after saving" [ "$(is_modified "$V")" = false ]
check "the tab has no modified marker" screen_has "secret.yaml \[sops\] ×"
check "no private temp directory is left" no_private_dirs

section "undo after a save"
saved=$(buffer_text "$V")
keys C-z
sleep 0.3
check "undo changes the text" [ "$(buffer_text "$V")" != "$saved" ]
check "undo marks the buffer modified" [ "$(is_modified "$V")" = true ]
keys C-y
sleep 0.3
check "redo restores the saved text" [ "$(buffer_text "$V")" = "$saved" ]

section "invalid content is refused"
before=$(sha secret.yaml)
append "$V" $'\nbroken: [unclosed\n'
mark_status
keys C-s
check "the error is reported with the parser message" wait_new_status "secret.yaml was not saved, the content is invalid: yaml: line"
check "the file is untouched" [ "$(sha secret.yaml)" = "$before" ]
check "sops is not left waiting" no_sops_running
check "no private temp directory is left" no_private_dirs
check "the buffer stays modified" [ "$(is_modified "$V")" = true ]
check "the error does not quote the content" lacks unclosed "$(new_status)"
fx <<EOF >/dev/null
const text = await editor.getBufferText($V);
const cut = editor.utf8ByteLength(text.slice(0, text.indexOf("\nbroken:")));
editor.deleteRange($V, cut, editor.getBufferLength($V));
await editor.delay(150);
return true;
EOF
mark_status
keys C-s
check "fixed content saves again" wait_new_status "secret.yaml (encrypted and saved|no changes)"
check "and the buffer is clean" [ "$(is_modified "$V")" = false ]

section "saving without changes"
before=$(sha secret.yaml)
mark_status
keys C-s
check "reports that there is nothing to save" wait_new_status "no changes to save in secret.yaml"
check "the file is untouched" [ "$(sha secret.yaml)" = "$before" ]

section "the file changed on disk: overwrite"
(cd "$PROJ" && sops set secret.yaml '["stringData"]["token"]' "\"ext1-$MARKER\"")
append "$V" $'\n    local: lc1'
keys C-s
check "a conflict popup asks what to do" wait_screen "file changed on disk"
mark_status
keys Enter
check "overwrite saves the local version" wait_new_status "secret.yaml encrypted and saved"
check "the local edit is in the file" grep -q "local: lc1" <(decrypted secret.yaml)
check "the external edit was overwritten" lacks ext1- "$(decrypted secret.yaml)"

section "the file changed on disk: reload"
(cd "$PROJ" && sops set secret.yaml '["stringData"]["token"]' "\"ext2-$MARKER\"")
append "$V" $'\n    local: lc2'
keys C-s
check "the conflict popup appears again" wait_screen "file changed on disk"
mark_status
keys Down Enter
check "reload replaces the buffer" wait_new_status "reloaded secret.yaml from disk"
V2=$(vbuf_id "secret.yaml [sops]")
check "a fresh buffer took its place" [ "$V2" != null ]
check "with a new id" [ "$V2" != "$V" ]
check "it shows the external edit" grep -q "ext2-$MARKER" <(buffer_text "$V2")
check "the local edit was discarded" lacks lc2 "$(decrypted secret.yaml)"
check "it is clean" [ "$(is_modified "$V2")" = false ]
V=$V2

section "an unmodified buffer follows changes on disk"
(cd "$PROJ" && sops set secret.yaml '["stringData"]["token"]' "\"ext3-$MARKER\"")
fx <<<'editor.openFile(P("plain.yaml")); await until(() => fbuf(P("plain.yaml"))); return true;' >/dev/null
fx <<<"editor.showBuffer($V); return true;" >/dev/null
check "switching back reloads it" wait_for "grep -q ext3-$MARKER <(buffer_text \$(vbuf_id 'secret.yaml [sops]'))"
V=$(vbuf_id "secret.yaml [sops]")

section "a plain file is left alone"
r=$(fx <<<'await editor.delay(500); const b = fbuf(P("plain.yaml")); return { file: b !== null, v: vbuf("plain.yaml [sops]") };')
check "it stays a normal file buffer" [ "$(jq -r .file <<<"$r")" = true ]
check "without a decrypted buffer" [ "$(jq -r .v <<<"$r")" = null ]

section "toggling between the decrypted and the encrypted view"
fx <<<"editor.showBuffer($V); return true;" >/dev/null
run_command "SOPS: Toggle Encrypted/Decrypted View"
r=$(fx <<<'const b = await until(() => { const a = editor.getBufferInfo(editor.getActiveBufferId()); return a && !a.is_virtual && a.path === P("secret.yaml") ? a : null; }); return { raw: b?.id ?? null, text: b ? await editor.getBufferText(b.id) : null };')
RAW=$(jq -r .raw <<<"$r")
check "toggle shows the encrypted file" [ "$RAW" != null ]
check "as it is on disk" [ "$(jq -r .text <<<"$r")" = "$(cat "$PROJ/secret.yaml")" ]
run_command "SOPS: Toggle Encrypted/Decrypted View"
check "toggle goes back to the decrypted buffer" wait_for "[ \"\$(fx <<<'return editor.getActiveBufferId();')\" = $V ]"
fx <<<"editor.closeBuffer($RAW); return true;" >/dev/null

section "other formats"
for spec in "app.env|NEW_VAR=nv-$MARKER" "conf.ini|extra = ex-$MARKER" "note.txt|third $MARKER"; do
  file=${spec%%|*}
  line=${spec#*|}
  r=$(open_decrypted "$file" "$file [sops]")
  id=$(jq -r .id <<<"$r")
  check "$file opens decrypted" [ "$id" != null ]
  check "$file shows what sops decrypts" [ "$(jq -r .text <<<"$r")" = "$(decrypted "$file")" ]
  append "$id" $'\n'"$line"
  mark_status
  run_command "SOPS: Encrypt and Save"
  check "$file saves" wait_new_status "$file encrypted and saved"
  check "$file decrypts to the edit" grep -qF "$line" <(decrypted "$file")
  check "$file keeps the value encrypted" [ "$(grep -c "$MARKER" "$PROJ/$file")" = 0 ]
done
r=$(open_decrypted app.json "app.json [sops]")
id=$(jq -r .id <<<"$r")
check "app.json opens decrypted" [ "$id" != null ]
check "app.json shows what sops decrypts" [ "$(jq -r .text <<<"$r")" = "$(decrypted app.json)" ]
fx <<EOF >/dev/null
const text = await editor.getBufferText($id);
const at = editor.utf8ByteLength(text.slice(0, text.indexOf('"admin"')));
editor.deleteRange($id, at, at + 7);
editor.insertText($id, at, '"root-$MARKER"');
await editor.delay(150);
return true;
EOF
mark_status
run_command "SOPS: Encrypt and Save"
check "app.json saves" wait_new_status "app.json encrypted and saved"
check "app.json decrypts to the edit" grep -q "root-$MARKER" <(decrypted app.json)

section "opening a second copy of the same file"
r=$(fx <<<"editor.openFile(P(\"secret.yaml\")); await editor.delay(800); return { active: editor.getActiveBufferId(), raw: fbuf(P(\"secret.yaml\")), count: bufs().filter(b => b.name === \"secret.yaml [sops]\").length };")
check "focuses the existing decrypted buffer" [ "$(jq -r .active <<<"$r")" = "$V" ]
check "without a second decrypted buffer" [ "$(jq -r .count <<<"$r")" = 1 ]
check "or a raw tab" [ "$(jq -r .raw <<<"$r")" = null ]

section "encrypting a plaintext file"
printf 'kind: Secret\nstringData:\n  password: fresh-value\n' >"$PROJ/secret-new.yaml"
fx <<<'editor.openFile(P("secret-new.yaml")); await until(() => fbuf(P("secret-new.yaml"))); return true;' >/dev/null
mark_status
run_command "SOPS: Encrypt Current File"
check "the file is encrypted in place" wait_new_status "secret-new.yaml is now encrypted"
check "by the .sops.yaml creation rule" grep -q "encrypted_regex" "$PROJ/secret-new.yaml"
check "and opened decrypted" wait_for "[ \"\$(vbuf_id 'secret-new.yaml [sops]')\" != null ]"

section "creating a new encrypted file"
run_command "SOPS: New Encrypted File…"
check "a prompt asks for the path" wait_screen "New SOPS file:"
type_text "secret-created.yaml"
keys Enter
check "an empty decrypted buffer opens" wait_for "[ \"\$(vbuf_id 'secret-created.yaml [sops]')\" != null ]"
C=$(vbuf_id "secret-created.yaml [sops]")
check "highlighted by its extension" [ "$(fx <<<"return editor.getBufferInfo($C)?.language;" | jq -r .)" = yaml ]
check "the file does not exist yet" [ ! -e "$PROJ/secret-created.yaml" ]
append "$C" $'stringData:\n    password: cr-'"$MARKER"$'\n'
mark_status
keys C-s
check "the first save creates the file" wait_new_status "created encrypted secret-created.yaml"
check "encrypted by the creation rule" grep -q "encrypted_regex" "$PROJ/secret-created.yaml"
check "with the typed content" grep -q "password: cr-$MARKER" <(decrypted secret-created.yaml)
check "and the value encrypted" [ "$(grep -c "$MARKER" "$PROJ/secret-created.yaml")" = 0 ]

section "autoDecrypt=never and the manual command"
set_setting autoDecrypt '"never"'
fx <<<'editor.openFile(P("nested/secret-copy.yaml")); await until(() => fbuf(P("nested/secret-copy.yaml"))); await editor.delay(800); return true;' >/dev/null
check "the file stays encrypted" [ "$(vbuf_id 'secret-copy.yaml [sops]')" = null ]
run_command "SOPS: Decrypt Current File"
check "the command decrypts it" wait_for "[ \"\$(vbuf_id 'secret-copy.yaml [sops]')\" != null ]"
set_setting autoDecrypt '"trusted"'

section "failures"
fx <<<"editor.closeBuffer(vbuf('app.env [sops]').id, true); return true;" >/dev/null
set_setting binPath '"/nonexistent/sops"'
mark_status
fx <<<'editor.openFile(P("app.env")); return true;' >/dev/null
check "a missing sops binary is reported" wait_new_status 'cannot run "/nonexistent/sops"'
check "and the file stays encrypted" [ "$(vbuf_id 'app.env [sops]')" = null ]
set_setting binPath '"sops"'
fx <<<'const b = fbuf(P("app.env")); if (b) editor.closeBuffer(b.id); await editor.delay(300); return true;' >/dev/null
set_setting ageKeyFile "\"$WORK/other.key\""
mark_status
fx <<<'editor.openFile(P("app.env")); return true;' >/dev/null
check "a missing key is reported with the reason" wait_new_status "no key can decrypt app.env: .*no identity matched"
check "and the file stays encrypted" [ "$(vbuf_id 'app.env [sops]')" = null ]
set_setting ageKeyFile '""'
fx <<<'const b = fbuf(P("app.env")); if (b) editor.closeBuffer(b.id); await editor.delay(300); return true;' >/dev/null

section "auto-save"
set_setting autoSaveDelay 1
fx <<<"editor.showBuffer($V); return true;" >/dev/null
check "the decrypted buffer is focused" wait_for "[ \"\$(fx <<<'return editor.getActiveBufferId();')\" = $V ]"
keys C-Home End
mark_status
type_text "-auto"
check "saves by itself after the delay" wait_new_status "secret.yaml encrypted and saved"
check "with the edit" grep -q "^apiVersion: v1-auto$" <(decrypted secret.yaml)
check "and the buffer is clean" wait_for "[ \"\$(is_modified $V)\" = false ]"
set_setting autoSaveDelay 0

section "reloading the plugin"
fx <<<'return await editor.reloadPlugin("sops");' >/dev/null
check "the editor closes its decrypted buffers" wait_for "[ \"\$(vbuf_id 'secret.yaml [sops]')\" = null ]"
r=$(open_decrypted secret.yaml "secret.yaml [sops]")
V=$(jq -r .id <<<"$r")
check "files open decrypted again" [ "$V" != null ]
append "$V" $'\n    after_reload: ar-'"$MARKER"
mark_status
keys C-s
check "and save again" wait_new_status "secret.yaml encrypted and saved"
check "to their file" grep -q "after_reload: ar-$MARKER" <(decrypted secret.yaml)

section "creationEnabled"
set_setting creationEnabled true
printf 'kind: Secret\nstringData:\n    password: typed-later\n' >"$PROJ/secret-auto.yaml"
fx <<'EOF' >/dev/null
editor.openFile(P("secret-auto.yaml"));
const b = await until(() => fbuf(P("secret-auto.yaml")));
editor.insertText(b.id, editor.getBufferLength(b.id), "    token: tk\n");
await editor.delay(200);
editor.executeAction("save");
return true;
EOF
check "saving a file a creation rule matches encrypts it" wait_for "[ \"\$(vbuf_id 'secret-auto.yaml [sops]')\" != null ]"
check "on disk" grep -q "password: ENC\[" "$PROJ/secret-auto.yaml"
check "with the saved content" grep -q "token: tk" <(decrypted secret-auto.yaml)
mark_status
fx <<'EOF' >/dev/null
editor.openFile(P("plain.yaml"));
const b = await until(() => fbuf(P("plain.yaml")));
editor.insertText(b.id, 0, "# edited\n");
await editor.delay(200);
editor.executeAction("save");
await editor.delay(2000);
return true;
EOF
check "a file no rule matches stays plaintext" grep -q "^# edited$" "$PROJ/plain.yaml"
check "silently" lacks SOPS "$(new_status)"
set_setting creationEnabled false

section "Save As writes plaintext: the plugin offers to encrypt it"
fx <<<"editor.showBuffer($V); await editor.delay(200); editor.executeAction(\"save_as\"); return true;" >/dev/null
check "Save As asks for a path" wait_screen "Save as:"
type_text "secret-exported.yaml"
keys Enter
check "a popup warns about the plaintext copy" wait_screen "plaintext written to disk"
mark_status
keys Enter
check "encrypt in place is chosen" wait_new_status "secret-exported.yaml is now encrypted"
check "the copy is encrypted on disk" [ "$(grep -c "$MARKER" "$PROJ/secret-exported.yaml")" = 0 ]
check "and shown decrypted" wait_for "[ \"\$(vbuf_id 'secret-exported.yaml [sops]')\" != null ]"
check "the original keeps its content" grep -q "after_reload: ar-$MARKER" <(decrypted secret.yaml)
r=$(open_decrypted secret.yaml "secret.yaml [sops]")
V=$(jq -r .id <<<"$r")

section "leaving the editor"
append "$V" $'\n    unsaved: un-'"$MARKER"
fx <<<'editor.executeAction("quit"); return true;' >/dev/null 2>&1 || true
check "the editor quits without a prompt" wait_for "! tmux -L '$TMUX_SOCK' has-session -t main 2>/dev/null"
check "the unsaved edit never reached the file" lacks unsaved "$(decrypted secret.yaml)"

section "no plaintext on disk"
leaks=$(grep -rl --exclude-dir=proj "$MARKER" "$WORK" "$RUN" 2>/dev/null || true)
check "no editor file (recovery, logs, sessions) holds a secret" [ -z "$leaks" ]
[ -z "$leaks" ] || printf '       %s\n' $leaks
check "every project file keeps its secrets encrypted" lacks . "$(grep -rl "$MARKER" "$PROJ" || true)"
check "no private temp directory is left" no_private_dirs

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = 0 ]
