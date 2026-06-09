const defaultBaseUrl = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
const defaultModel = "doubao-seed-1-6-flash-250615";
const defaultAliyunBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const defaultAliyunModel = "qwen-plus";

export function createAssistantResponder({
  provider,
  apiKey,
  model,
  baseUrl,
  maxTokens = process.env.MONITOR_ASSISTANT_MAX_TOKENS,
  fetchImpl = globalThis.fetch
} = {}) {
  const resolvedProvider = resolveAssistantProvider(provider);
  const providerConfig = chatProviderConfig(resolvedProvider);
  const resolvedApiKey = apiKey ?? providerConfig.apiKey;
  const resolvedModel = model || providerConfig.model;
  const resolvedBaseUrl = baseUrl || providerConfig.baseUrl;

  return async function respond(turn) {
    if (!resolvedApiKey) return fallbackAssistantReply(turn);

    try {
      const response = await fetchImpl(resolvedBaseUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolvedApiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: resolvedModel,
          messages: buildAssistantMessages(turn),
          temperature: 0.4,
          max_tokens: resolveAssistantMaxTokens(maxTokens)
        })
      });

      if (!response.ok) {
        const body = typeof response.text === "function" ? await response.text() : "";
        const status = response.status || 502;
        throw new Error(`assistant_chat_failed_${status}: ${body.slice(0, 160)}`);
      }

      const data = await response.json();
      const text = normalizeAssistantText(data?.choices?.[0]?.message?.content);
      if (!text) throw new Error("assistant_chat_empty_response");
      return { text, source: resolvedProvider };
    } catch (caught) {
      const fallback = fallbackAssistantReply(turn);
      return {
        ...fallback,
        error: caught instanceof Error ? caught.message : String(caught)
      };
    }
  };
}

function resolveAssistantProvider(provider, env = process.env) {
  const explicit = String(provider || env.MONITOR_ASSISTANT_PROVIDER || "").trim().toLowerCase();
  if (explicit) return explicit;
  if (env.DASHSCOPE_API_KEY || env.ALIYUN_DASHSCOPE_API_KEY || env.MONITOR_ALIYUN_API_KEY || env.ALIYUN_API_KEY) {
    return "aliyun";
  }
  return "doubao";
}

function chatProviderConfig(provider, env = process.env) {
  if (provider === "aliyun") {
    return {
      apiKey: env.DASHSCOPE_API_KEY || env.ALIYUN_DASHSCOPE_API_KEY || env.MONITOR_ALIYUN_API_KEY || env.ALIYUN_API_KEY || "",
      model: env.MONITOR_ASSISTANT_MODEL || env.ALIYUN_CHAT_MODEL || env.DASHSCOPE_CHAT_MODEL || defaultAliyunModel,
      baseUrl: env.MONITOR_ASSISTANT_URL || env.ALIYUN_CHAT_URL || defaultAliyunBaseUrl
    };
  }

  return {
    apiKey: env.DOUBAO_CHAT_API_KEY || env.DOUBAO_API_KEY || env.ARK_API_KEY || env.VOLCENGINE_API_KEY || "",
    model: env.DOUBAO_CHAT_MODEL || env.MONITOR_ASSISTANT_MODEL || defaultModel,
    baseUrl: env.DOUBAO_CHAT_URL || defaultBaseUrl
  };
}

export function buildAssistantMessages({
  text = "",
  agent = "codex",
  preparedForAgent = false,
  intent = {},
  history = []
} = {}) {
  const toolState = preparedForAgent
    ? `已经把用户命令准备给 ${agentLabel(agent)}，等待用户按右键发送。`
    : "这是一轮普通语音对话，不要把内容当作已交给开发工具。";
  const currentText = normalizeAssistantText(text);
  const recentTurns = normalizeAssistantHistoryTurns(history, currentText);

  const messages = [
    {
      role: "system",
      content:
        "你是 StopWatch 里的中文连续语音对话助手，名字叫傻妞。" +
        "你必须结合前面多轮 user/assistant 消息理解省略、追问和用户回答。" +
        "如果你上一轮提出了问题，用户当前回答通常是在回答那个问题，要基于回答继续推进。" +
        "信息足够时直接回答；信息不足时只追问一个具体问题。" +
        "回复必须短，适合手表扬声器播放，最多 28 个汉字。不要使用 Markdown。" +
        "如果用户是在下开发命令，只确认下一步，不要展开写代码。"
    }
  ];

  messages.push(...recentTurns);
  messages.push({
    role: "user",
    content:
      `${currentText}\n\n` +
      `识别动作：${intent?.action || "unknown"}\n` +
      `目标工具：${agentLabel(agent)}\n` +
      `工具状态：${toolState}`
  });

  return messages;
}

export function fallbackAssistantReply({ text = "", agent = "codex", preparedForAgent = false } = {}) {
  if (preparedForAgent) {
    return { text: `已准备交给 ${agentLabel(agent)}，按右键发送。`, source: "local" };
  }

  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return { text: "我没有听清，再说一次。", source: "local" };
  return { text: `我听到了：${clipChinese(clean, 24)}`, source: "local" };
}

function normalizeAssistantText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function agentLabel(agent) {
  return String(agent || "").toLowerCase() === "claude" ? "Claude Code" : "Codex";
}

function clipChinese(value, maxLength) {
  const chars = Array.from(String(value || ""));
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join("")}...` : chars.join("");
}

function normalizeAssistantHistoryTurns(history = [], currentText = "", maxTurns = 6) {
  const normalizedCurrent = normalizeAssistantText(currentText);
  const turns = history
    .slice(-maxTurns)
    .map((turn) => {
      const role = turn?.role === "assistant" ? "assistant" : "user";
      const content = normalizeAssistantText(turn?.text);
      return { role, content: clipChinese(content, 80) };
    })
    .filter((turn) => Boolean(turn.content));

  if (turns.at(-1)?.role === "user" && turns.at(-1)?.content === normalizedCurrent) {
    return turns.slice(0, -1);
  }

  return turns;
}

function resolveAssistantMaxTokens(value, fallback = 80) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}
