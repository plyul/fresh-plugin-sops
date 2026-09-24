# Shared setup for the end-to-end tests; sourced by run.sh.
#
# Starts Fresh inside a private tmux server with its own XDG directories, so the
# user's config, sessions and running editors are never touched, links this
# package in as a plugin, and creates a disposable age key and project.
#
# Needs: fresh, sops (>= 3.9), age-keygen, tmux, jq.

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
FRESH=${FRESH:-fresh}

# Never talk to the editor this script may itself be running inside.
unset FRESH_SESSION FRESH_CMD_TOKEN FRESH_INTERACTIVE FRESH_BIN

WORK=$(mktemp -d "${TMPDIR:-/tmp}/fresh-sops-e2e.XXXXXX")
# Short on purpose: the editor's control socket lives here and sun_path holds ~108 bytes.
RUN=$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/fse2e.XXXXXX")
TMUX_SOCK="fresh-sops-e2e-$$"
PROJ="$WORK/proj"
# Every secret value in the fixtures contains this; nothing outside encrypted files may.
MARKER="plaintextmarker$(date +%s)$$"

export XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state"
export XDG_CACHE_HOME="$WORK/cache" XDG_RUNTIME_DIR="$RUN" TMPDIR="$RUN"
export SOPS_AGE_KEY_FILE="$WORK/age.key" FRESH_SOPS_E2E_TOKEN="$WORK/token"
export TERM=xterm-256color

PASSED=0
FAILED=0

cleanup() {
  tmux -L "$TMUX_SOCK" kill-server 2>/dev/null || true
  if [ "${KEEP:-0}" = 1 ]; then
    echo "kept: WORK=$WORK RUN=$RUN (tmux -L $TMUX_SOCK attach)"
  else
    rm -rf "$WORK" "$RUN"
  fi
}
trap cleanup EXIT

ok() { PASSED=$((PASSED + 1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; return 0; }
check() { # check "description" <command...>
  local desc=$1; shift
  if "$@"; then ok "$desc"; else fail "$desc"; fi
}
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

setup_project() {
  age-keygen -o "$SOPS_AGE_KEY_FILE" 2>/dev/null
  age-keygen -o "$WORK/other.key" 2>/dev/null
  AGE_PUB=$(grep -o 'age1[0-9a-z]*' "$SOPS_AGE_KEY_FILE" | head -n 1)
  mkdir -p "$PROJ/nested"
  cat >"$PROJ/.sops.yaml" <<EOF
creation_rules:
  - path_regex: secret[^/]*\.yaml\$
    encrypted_regex: ^(data|stringData|password|token)\$
    age: $AGE_PUB
  - path_regex: .*\.(env|ini|json|txt)\$
    age: $AGE_PUB
EOF
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: demo\nstringData:\n  password: pw-%s\n  token: tk-%s\n' \
    "$MARKER" "$MARKER" >"$PROJ/secret.yaml"
  printf 'DB_USER=admin\nDB_PASS=pass-%s\n' "$MARKER" >"$PROJ/app.env"
  printf '[db]\nuser = admin\npass = pass-%s\n' "$MARKER" >"$PROJ/conf.ini"
  printf '{"user": "admin", "pass": "pass-%s"}\n' "$MARKER" >"$PROJ/app.json"
  printf 'line one\nline two %s\n' "$MARKER" >"$PROJ/note.txt"
  (cd "$PROJ" && for f in secret.yaml app.env conf.ini app.json note.txt; do sops encrypt -i "$f"; done)
  cp "$PROJ/secret.yaml" "$PROJ/nested/secret-copy.yaml"
  printf 'kind: ConfigMap\ndata:\n  plain: value\n' >"$PROJ/plain.yaml"
}

setup_editor() {
  mkdir -p "$XDG_CONFIG_HOME/fresh/plugins/packages"
  ln -s "$REPO" "$XDG_CONFIG_HOME/fresh/plugins/packages/sops"
  cp "$REPO/tests/e2e/helper/e2e_helper.ts" "$XDG_CONFIG_HOME/fresh/plugins/"
  cat >"$XDG_CONFIG_HOME/fresh/config.json" <<'EOF'
{
  "version": 2,
  "locale": "en",
  "check_for_updates": false,
  "plugins": {
    "welcome_screen": { "enabled": false },
    "dashboard": { "enabled": false }
  }
}
EOF
}

start_editor() {
  tmux -L "$TMUX_SOCK" new-session -d -s main -x 200 -y 50 -c "$PROJ" "$FRESH --no-upgrade-check --no-restore"
  local i
  for i in $(seq 1 100); do
    [ -s "$FRESH_SOPS_E2E_TOKEN" ] && break
    sleep 0.2
  done
  [ -s "$FRESH_SOPS_E2E_TOKEN" ] || { echo "editor did not start"; tmux -L "$TMUX_SOCK" capture-pane -p -t main; exit 1; }
  SESSION=$(sed -n 1p "$FRESH_SOPS_E2E_TOKEN")
  TOKEN=$(sed -n 2p "$FRESH_SOPS_E2E_TOKEN")
}

# Helpers available to every script run through `fx`.
PRELUDE='
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await editor.delay(100);
  }
};
const bufs = () => editor.listBuffers();
const vbuf = (name) => bufs().find((b) => b.is_virtual && b.name === name) ?? null;
const fbuf = (path) => bufs().find((b) => !b.is_virtual && b.path === path) ?? null;
const P = (name) => `'"$PROJ"'/${name}`;
'

# Run a TypeScript snippet in the editor; prints its JSON result.
fx() {
  local body out
  body=$(cat)
  if ! out=$(printf '%s\n%s\n' "$PRELUDE" "$body" |
    FRESH_SESSION="$SESSION" FRESH_CMD_TOKEN="$TOKEN" "$FRESH" --cmd script run - 2>&1); then
    printf 'script failed: %s\n--- script:\n%s\n---\n' "$out" "$body" >&2
    return 1
  fi
  # The editor prints nothing for a null result.
  printf '%s\n' "${out:-null}"
}

keys() { tmux -L "$TMUX_SOCK" send-keys -t main "$@"; }
type_text() { tmux -L "$TMUX_SOCK" send-keys -t main -l -- "$1"; }
screen() { tmux -L "$TMUX_SOCK" capture-pane -p -t main; }
screen_has() { screen | grep -qE -- "$1"; }
status_log() { cat "$XDG_STATE_HOME"/fresh/logs/status-*.log 2>/dev/null || true; }
lacks() { ! grep -qE -- "$1" <<<"$2"; }

# Poll a shell condition (evaluated in this shell, so functions work) for ~15s.
wait_for() {
  local i
  for i in $(seq 1 75); do
    if eval "$1" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}
wait_screen() { wait_for "screen_has $(printf '%q' "$1")"; }

# Wait until the status log gains a line matching the regex; prints it.
wait_status() {
  local re=$1 tries=${2:-100} i
  for i in $(seq 1 "$tries"); do
    if status_log | grep -E -- "$re" | tail -n 1 | grep -q .; then
      status_log | grep -E -- "$re" | tail -n 1
      return 0
    fi
    sleep 0.2
  done
  return 1
}

decrypted() { (cd "$PROJ" && sops decrypt "$1"); }
