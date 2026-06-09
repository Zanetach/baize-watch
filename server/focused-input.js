const editableRoles = new Set([
  "AXTextArea",
  "AXTextField",
  "AXSearchField",
  "AXComboBox"
]);

const dictationFallbackApps = new Set([
  "claude",
  "claude code",
  "codex",
  "feishu",
  "lark",
  "wechat",
  "wecom",
  "weixin",
  "飞书",
  "企业微信",
  "微信"
]);

export function buildFocusedInputProbeScript() {
  return [
    "-e", "tell application \"System Events\"",
    "-e", "set frontApp to name of first application process whose frontmost is true",
    "-e", "set focusedRole to \"\"",
    "-e", "set focusedSubrole to \"\"",
    "-e", "set focusedDescription to \"\"",
    "-e", "try",
    "-e", "set frontProcess to first application process whose frontmost is true",
    "-e", "set focusedElement to value of attribute \"AXFocusedUIElement\" of frontProcess",
    "-e", "set focusedRole to value of attribute \"AXRole\" of focusedElement as text",
    "-e", "try",
    "-e", "set focusedSubrole to value of attribute \"AXSubrole\" of focusedElement as text",
    "-e", "end try",
    "-e", "try",
    "-e", "set focusedDescription to value of attribute \"AXRoleDescription\" of focusedElement as text",
    "-e", "end try",
    "-e", "end try",
    "-e", "return frontApp & \"|||\" & focusedRole & \"|||\" & focusedSubrole & \"|||\" & focusedDescription",
    "-e", "end tell"
  ];
}

export function parseFocusedInputProbe(output) {
  const [app = "", role = "", subrole = "", description = ""] = String(output || "")
    .trimEnd()
    .split("|||");

  return {
    app: app.trim(),
    role: role.trim(),
    subrole: subrole.trim(),
    description: description.trim()
  };
}

export function isFocusedTextInput(info = {}) {
  const role = String(info.role || "").trim();
  if (editableRoles.has(role)) return true;
  if (role === "AXStaticText" || role === "AXButton") return false;

  const description = String(info.description || "").trim().toLowerCase();
  if (!description) return isKnownDictationFallbackApp(info.app);

  return /\b(?:editable text|text area|text field|search field|combo box)\b/u.test(description) ||
    /(输入|编辑|文本框|文字输入|搜索框)/u.test(description) ||
    isKnownDictationFallbackApp(info.app);
}

function isKnownDictationFallbackApp(value) {
  const app = String(value || "")
    .replace(/\.app$/iu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return dictationFallbackApps.has(app);
}
