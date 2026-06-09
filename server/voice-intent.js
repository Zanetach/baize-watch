import { normalizeTargetApp } from "./app-targets.js";

const commandPrefixes = "(我要|我想|帮我|请帮我|给我|麻烦你|麻烦帮我|帮忙)";
const optionalAdverb = "(先|再|直接|现在)?";
const noPunctuation = "[^，。！？,.!?]*";
const developmentTarget = [
  "小游戏",
  "贪吃蛇",
  "页面",
  "网页",
  "网站",
  "应用",
  "app",
  "APP",
  "小程序",
  "功能",
  "组件",
  "工具",
  "项目",
  "程序",
  "脚本",
  "插件",
  "系统",
  "接口",
  "API",
  "服务",
  "后端",
  "前端",
  "README",
  "文档",
  "测试",
  "布局",
  "动画",
  "界面",
  "(?:一个|个|那个|这个|下个)[^，。！？,.!?]*游戏"
].join("|");

const developerActionPattern = new RegExp(
  `${commandPrefixes}${optionalAdverb}打(?!开|电话|车|字|针|球|架)(?=${noPunctuation}(?:${developmentTarget}))`,
  "gu"
);
const developerHomophonePattern = new RegExp(
  `${commandPrefixes}${optionalAdverb}(?:开花|开法|开罚)(?=${noPunctuation}(?:${developmentTarget}))`,
  "gu"
);
const routeTarget = "(codex|扣得|claude\\s*code|claude|克劳德|微信|wechat|weixin|飞书|feishu|lark|当前(?:窗口|聊天)?|这个(?:窗口|聊天)?|这里)";
const routePattern = new RegExp(`^(?:发给|发送给|转给|转到|输入到|发到|发送到|写到|粘贴到|交给)\\s*${routeTarget}\\s*[:：，,。 ]*(.+)$`, "iu");
const exitHomophonePattern = /^(?:等一下|等下|等一吓)(?:吧|了|啦|哦|啊)?[。.!！]?$/u;
const exitConversationPattern = /^(?:(?:退出|结束|停止|关闭)(?:语音)?(?:连续)?(?:对话|聊天)?|不聊了|退下|再见|拜拜)(?:吧|了|啦|哦|啊)?[。.!！]?$/u;
const embeddedExitConversationPattern = /(?:你给我|给我|帮我|请)?(?:退出|结束|停止|关闭)(?:语音)?(?:连续)?(?:对话|聊天)/u;
const assistantQuestionHomophonePattern = /^为什么[。.!！]?$/u;

export function normalizeVoiceCommand(value, options = {}) {
  return interpretVoiceCommand(value, options).normalized;
}

export function interpretVoiceCommand(value, { agent = "" } = {}) {
  const raw = normalizeText(value);
  const corrections = [];
  const route = parseRoute(raw);
  let normalized = route?.text || raw;

  normalized = applyCorrection(normalized, developerActionPattern, corrections, "developer_action_confusion");
  normalized = applyCorrection(normalized, developerHomophonePattern, corrections, "developer_homophone");
  normalized = correctExitHomophone(normalized, corrections);
  normalized = correctAssistantQuestionHomophone(normalized, corrections);

  const action = classifyAction(normalized, route);
  const confidence = corrections.length ? 0.92 : 1;

  return {
    raw,
    normalized,
    action,
    targetAgent: route?.agent || "",
    targetApp: route?.app || "",
    confidence,
    needsConfirm: confidence < 0.75,
    corrections,
    agent: String(agent || "")
  };
}

function correctExitHomophone(text, corrections) {
  if (!exitHomophonePattern.test(text)) return text;
  corrections.push({ type: "exit_homophone", from: text, to: "退下" });
  return "退下";
}

function correctAssistantQuestionHomophone(text, corrections) {
  if (!assistantQuestionHomophonePattern.test(text)) return text;
  corrections.push({ type: "assistant_question_homophone", from: text, to: "你会什么" });
  return "你会什么";
}

function parseRoute(text) {
  const match = String(text || "").match(routePattern);
  if (!match) return null;
  const target = normalizeTargetApp(match[1]);
  const routedText = normalizeText(match[2]);
  if (target === "codex" || target === "claude") {
    return {
      agent: target,
      text: routedText
    };
  }
  return {
    app: target || "current",
    text: routedText
  };
}

function applyCorrection(text, pattern, corrections, type) {
  return text.replace(pattern, (match, prefix, adverb = "") => {
    const replacement = `${prefix}${adverb}开发`;
    corrections.push({ type, from: match, to: replacement });
    return replacement;
  });
}

function classifyAction(text, route = null) {
  if (route?.agent) return "agent";
  if (route?.app) return "dictate";
  if (exitConversationPattern.test(text) || embeddedExitConversationPattern.test(text)) return "exit_conversation";
  if (/(开发|实现|创建|生成|写|做|设计|修复|优化|修改|改|搭建|新增)/u.test(text)) return "develop";
  if (/(打开|启动|切换到|进入)/u.test(text)) return "open";
  if (/(发送|提交|回车|确认发送)/u.test(text)) return "send";
  if (/(总结|分析|解释|检查|看一下|帮我看看|你会什么|能做什么|会做什么)/u.test(text)) return "ask";
  return "unknown";
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
