const appAliases = new Map([
  ["codex", "codex"],
  ["扣得", "codex"],
  ["claude", "claude"],
  ["claude code", "claude"],
  ["claudecode", "claude"],
  ["克劳德", "claude"],
  ["微信", "wechat"],
  ["wechat", "wechat"],
  ["weixin", "wechat"],
  ["飞书", "feishu"],
  ["feishu", "feishu"],
  ["lark", "feishu"],
  ["当前", "current"],
  ["当前窗口", "current"],
  ["当前聊天", "current"],
  ["这个窗口", "current"],
  ["这个聊天", "current"],
  ["这里", "current"]
]);

const activationNames = new Map([
  ["codex", "Codex"],
  ["wechat", "WeChat"],
  ["feishu", "Feishu"],
  ["current", ""],
  ["claude", ""]
]);

export function normalizeTargetApp(value) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return appAliases.get(normalized) || "";
}

export function activationNameForTargetApp(value) {
  const target = normalizeTargetApp(value) || String(value || "").trim().toLowerCase();
  return activationNames.get(target) || "";
}

export function buildPasteScript() {
  return [
    "-e", "on run argv",
    "-e", "set the clipboard to item 1 of argv",
    "-e", "set targetApp to item 2 of argv",
    "-e", "if targetApp is not \"\" then",
    "-e", "try",
    "-e", "tell application targetApp to activate",
    "-e", "delay 0.25",
    "-e", "end try",
    "-e", "end if",
    "-e", "tell application \"System Events\" to keystroke \"v\" using command down",
    "-e", "end run"
  ];
}
