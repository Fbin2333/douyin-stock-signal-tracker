const ALLOWED_LABELS = new Set(["signal", "consultation", "post_hoc", "chat", "ambiguous"]);

export function normalizeAgentClassification(value, fallback = {}) {
  const label = ALLOWED_LABELS.has(String(value?.label || "").trim())
    ? String(value.label).trim()
    : "ambiguous";
  const confidence = Number(value?.confidence);
  return {
    label,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    reason: String(value?.reason || fallback.reason || "").slice(0, 500),
    source: fallback.source || "semantic_agent",
    model: fallback.model || ""
  };
}

export function buildSemanticAgentMessages(comment, mentions) {
  return [
    {
      role: "system",
      content: [
        "你是抖音股票评论语义识别 agent，只做分类，不做投资建议。",
        "目标是判断一条含 A 股名称或代码的评论，是否应该作为该评论者当时提出的新股票信号入账。",
        "只返回 JSON，不要输出其他文字。",
        "label 只能是 signal、consultation、post_hoc、chat、ambiguous。",
        "signal：当下推荐、看好、提示关注、给出操作方向或明确提出股票。",
        "consultation：在问别人/博主股票能否买、怎么看、怎么操作、是否解套等。",
        "post_hoc：事后说自己以前推荐过、以前说过、别人没买、已经涨了、吃肉了等。",
        "chat：闲聊、非股票信号。",
        "ambiguous：无法可靠判断。宁可 ambiguous，也不要把咨询或事后复盘判成 signal。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          comment_text: comment.text || "",
          comment_date: comment.create_date || "",
          video_date: comment.video_create_date || "",
          video_desc: comment.video_desc || "",
          stock_mentions: mentions.map((item) => ({
            symbol: item.symbol,
            name: item.name,
            mention_text: item.mentionText
          })),
          output_schema: {
            label: "signal | consultation | post_hoc | chat | ambiguous",
            confidence: "0..1",
            reason: "简短中文理由"
          }
        },
        null,
        2
      )
    }
  ];
}

export async function classifyWithSemanticAgent(comment, mentions, config) {
  if (!config?.endpoint) {
    throw new Error("SIGNAL_AGENT_ENDPOINT is required for semantic agent mode");
  }
  if (!config?.apiKey) {
    throw new Error("SIGNAL_AGENT_API_KEY is required for semantic agent mode");
  }
  if (!config?.model) {
    throw new Error("SIGNAL_AGENT_MODEL is required for semantic agent mode");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config.timeoutMs || 30000));
  let response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: buildSemanticAgentMessages(comment, mentions)
      })
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Semantic agent HTTP ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Semantic agent response did not include choices[0].message.content");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Semantic agent returned invalid JSON: ${content.slice(0, 300)}`);
  }

  return normalizeAgentClassification(parsed, {
    source: "semantic_agent",
    model: config.model
  });
}
