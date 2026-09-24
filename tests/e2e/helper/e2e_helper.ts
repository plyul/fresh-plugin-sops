// Test-only plugin, installed into the throwaway editor by tests/e2e/run.sh.
//
// `fresh --cmd script run` needs a capability token, and the editor only hands
// one to terminals it opens with `allowScript`. This opens such a terminal and
// has it write its session name and token to $FRESH_SOPS_E2E_TOKEN.

const editor = getEditor();

editor.on("ready", async () => {
  try {
    const out = editor.getEnv("FRESH_SOPS_E2E_TOKEN");
    if (!out) return;
    const editorSplit = editor.getActiveSplitId();
    await editor.createTerminal({
      command: [
        "sh",
        "-c",
        'printf "%s\\n%s\\n" "$FRESH_SESSION" "$FRESH_CMD_TOKEN" > "$0.tmp" && mv "$0.tmp" "$0" && exec sleep 1000000',
        out,
      ],
      allowScript: true,
      focus: false,
      direction: "horizontal",
      ratio: 0.9,
      title: "e2e",
    });
    editor.focusSplit(editorSplit);
  } catch (e) {
    editor.error(`e2e_helper: ${e}`);
  }
});
