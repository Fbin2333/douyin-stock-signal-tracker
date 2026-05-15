import { pinyin } from "pinyin-pro";
import { normalizeSearchText, nowIso, stableUserId } from "./common.mjs";
import {
  getCommentSignalLabel,
  getIgnoredUserKeys,
  upsertCommentSignalLabel,
  upsertMention
} from "./db.mjs";
import { extractRawStockMentions } from "./mentions.mjs";
import { getDictionaryStocks, getDictionaryTerms } from "./stock-data.mjs";

const ALLOWED_LABELS = new Set(["signal", "consultation", "post_hoc", "chat", "ambiguous"]);
const COMMON_SHORT_TERMS = new Set([
  "中国",
  "股份",
  "科技",
  "集团",
  "发展",
  "控股",
  "实业",
  "能源",
  "电力",
  "电子",
  "信息",
  "国际",
  "建设",
  "证券",
  "银行"
]);
const MAX_CANDIDATES_PER_TERM = 5;

function onlyChinese(value = "") {
  return String(value).match(/\p{Script=Han}/gu)?.join("") || "";
}

function alphaTokens(value = "") {
  return [...String(value).matchAll(/[A-Za-z]{3,12}/g)].map((match) => match[0].toLowerCase());
}

function makePinyinInitials(value = "") {
  const text = onlyChinese(value);
  if (text.length < 2) return "";
  return pinyin(text, { pattern: "first", toneType: "none", type: "array" })
    .join("")
    .toLowerCase();
}

function makeFullPinyin(value = "") {
  const text = onlyChinese(value);
  if (text.length < 2) return "";
  return pinyin(text, { toneType: "none", type: "array" }).join("").toLowerCase();
}

function addTerm(index, term, stock, aliasType) {
  const key = String(term || "").trim().toLowerCase();
  if (key.length < 2 || COMMON_SHORT_TERMS.has(key)) return;
  if (!index.has(key)) index.set(key, []);
  index.get(key).push({ ...stock, mentionText: term, aliasType });
}

export function buildAbbreviationIndex(stocks) {
  const chinese = new Map();
  const alpha = new Map();
  for (const stock of stocks) {
    const chineseName = onlyChinese(stock.name);
    if (chineseName.length >= 3) {
      addTerm(chinese, chineseName.slice(0, 2), stock, "chinese_prefix_2");
      if (chineseName.length >= 4) {
        addTerm(chinese, chineseName.slice(0, 3), stock, "chinese_prefix_3");
      }
    }
    const initials = makePinyinInitials(stock.name);
    if (initials.length >= 3) {
      addTerm(alpha, initials, stock, "pinyin_initials");
    }
    const fullPinyin = makeFullPinyin(stock.name);
    if (fullPinyin.length >= 5 && fullPinyin.length <= 16) {
      addTerm(alpha, fullPinyin, stock, "pinyin_full");
    }
  }
  return { chinese, alpha };
}

function collectCandidatesForTerm(candidatesBySymbol, matches, matchedTerm) {
  if (!matches || matches.length === 0 || matches.length > MAX_CANDIDATES_PER_TERM) return;
  for (const match of matches) {
    if (!candidatesBySymbol.has(match.symbol)) {
      candidatesBySymbol.set(match.symbol, { ...match, mentionText: matchedTerm });
    }
  }
}

export function findAbbreviationCandidates(text, index) {
  const rawText = String(text || "");
  const normalizedText = normalizeSearchText(rawText).toLowerCase().replace(/\s+/g, "");
  const candidatesBySymbol = new Map();

  for (const [term, matches] of index.chinese.entries()) {
    if (normalizedText.includes(term)) {
      collectCandidatesForTerm(candidatesBySymbol, matches, term);
    }
  }

  const tokens = new Set(alphaTokens(rawText));
  for (const token of tokens) {
    collectCandidatesForTerm(candidatesBySymbol, index.alpha.get(token), token);
  }

  return [...candidatesBySymbol.values()];
}

function normalizeResolverItem(item, fallback = {}) {
  const label = ALLOWED_LABELS.has(String(item?.label || "").trim())
    ? String(item.label).trim()
    : "ambiguous";
  const confidence = Number(item?.confidence);
  return {
    matched: Boolean(item?.matched),
    symbol: String(item?.symbol || fallback.symbol || "").trim().toUpperCase(),
    name: String(item?.name || fallback.name || "").trim(),
    mentionText: String(item?.mention_text || item?.mentionText || fallback.mentionText || "").trim(),
    label,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reason: String(item?.reason || "").slice(0, 500)
  };
}

export function buildAbbreviationResolverMessages(comment, candidates) {
  return [
    {
      role: "system",
      content: [
        "你是 A 股评论缩写归一化 agent，只做信息抽取，不做投资建议。",
        "输入是一条抖音评论和本地字典召回的候选股票，判断评论中的简称/拼音缩写是否指向候选股票。",
        "同时判断这条评论是否应该作为该评论者当时提出的新股票信号入账。",
        "label 只能是 signal、consultation、post_hoc、chat、ambiguous。",
        "signal：当下推荐、看好、提示关注、给出操作方向或明确提出股票。",
        "consultation：在问别人/博主股票能否买、怎么看、怎么操作、是否解套等。",
        "post_hoc：事后说以前推荐过、以前说过、已经涨了、卖了、吃肉了等。",
        "chat：闲聊、非股票信号。",
        "ambiguous：无法可靠判断。宁可 ambiguous，也不要把咨询或事后复盘判成 signal。",
        "只返回 JSON，不要输出其他文字。"
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
          candidates: candidates.map((item) => ({
            symbol: item.symbol,
            name: item.name,
            mention_text: item.mentionText,
            alias_type: item.aliasType
          })),
          output_schema: {
            items: [
              {
                matched: "boolean",
                symbol: "候选股票 symbol",
                name: "股票名",
                mention_text: "评论中的简称或拼音缩写",
                label: "signal | consultation | post_hoc | chat | ambiguous",
                confidence: "0..1",
                reason: "简短中文理由"
              }
            ]
          }
        },
        null,
        2
      )
    }
  ];
}

export async function resolveWithAbbreviationAgent(comment, candidates, config) {
  if (!config?.endpoint) {
    throw new Error("SIGNAL_AGENT_ENDPOINT is required for abbreviation resolver");
  }
  if (!config?.apiKey) {
    throw new Error("SIGNAL_AGENT_API_KEY is required for abbreviation resolver");
  }
  if (!config?.model) {
    throw new Error("SIGNAL_AGENT_MODEL is required for abbreviation resolver");
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
        messages: buildAbbreviationResolverMessages(comment, candidates)
      })
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Abbreviation agent HTTP ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Abbreviation agent response did not include choices[0].message.content");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Abbreviation agent returned invalid JSON: ${content.slice(0, 300)}`);
  }

  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  return items.map((item) => normalizeResolverItem(item));
}

export async function resolveAbbreviationsForAllComments(
  db,
  {
    signalAgent,
    limit = 0,
    minConfidence = 0.7,
    dryRun = false,
    term = "",
    since = "",
    firstSeenSince = "",
    agentResolver = resolveWithAbbreviationAgent
  } = {}
) {
  const stocks = getDictionaryStocks(db);
  const dictionaryTerms = getDictionaryTerms(db);
  const index = buildAbbreviationIndex(stocks);
  const ignoredUsers = getIgnoredUserKeys(db);
  const comments = db
    .prepare(
      `
      SELECT c.*, v.create_date AS video_create_date, v.desc AS video_desc
      FROM comments AS c
      LEFT JOIN videos AS v ON v.aweme_id = c.aweme_id
      WHERE (? = '' OR c.create_date >= ?)
        AND (? = '' OR c.first_seen_at >= ?)
      ORDER BY c.create_time ASC, c.cid ASC
    `
    )
    .all(since, since, firstSeenSince, firstSeenSince);
  const existingMentions = new Set(
    db.prepare("SELECT comment_cid || char(9) || symbol AS key FROM stock_mentions")
      .all()
      .map((row) => row.key)
  );
  const termFilter = String(term || "").trim().toLowerCase();

  const stats = {
    scanned: 0,
    candidateComments: 0,
    agentCalls: 0,
    matched: 0,
    created: 0,
    rejectedContext: 0,
    skippedIgnored: 0,
    skippedExisting: 0,
    skippedAmbiguousCandidate: 0,
    skippedLowConfidence: 0,
    skippedNoCandidate: 0,
    dryRun,
    errors: 0
  };

  for (const comment of comments) {
    stats.scanned += 1;
    if (ignoredUsers.has(`${comment.account_id}\t${stableUserId(comment)}`)) {
      stats.skippedIgnored += 1;
      continue;
    }
    const deterministicMentions = extractRawStockMentions(comment.text, dictionaryTerms);
    const deterministicSymbols = new Set(deterministicMentions.map((item) => item.symbol));
    let candidates = findAbbreviationCandidates(comment.text, index).filter(
      (item) => !deterministicSymbols.has(item.symbol)
    );
    candidates = candidates.filter((item) => {
      const mentionText = String(item.mentionText || "").toLowerCase();
      return !deterministicMentions.some(
        (mention) =>
          mention.symbol !== item.symbol &&
          String(mention.mentionText || "").toLowerCase().startsWith(mentionText)
      );
    });
    if (termFilter) {
      candidates = candidates.filter(
        (item) =>
          String(item.mentionText || "").toLowerCase() === termFilter ||
          String(item.name || "").toLowerCase().includes(termFilter)
      );
    }
    candidates = candidates.filter(
      (item) => !existingMentions.has(`${comment.cid}\t${item.symbol}`)
    );
    if (candidates.length === 0) {
      stats.skippedNoCandidate += 1;
      continue;
    }

    const existingLabel = getCommentSignalLabel(db, comment.cid);
    if (existingLabel?.source === "abbreviation_agent") {
      stats.skippedExisting += 1;
      continue;
    }

    stats.candidateComments += 1;
    stats.agentCalls += 1;
    const allowedCandidates = new Map(candidates.map((item) => [item.symbol, item]));
    let resolutions = [];
    try {
      resolutions = await agentResolver(comment, candidates, signalAgent);
    } catch (error) {
      stats.errors += 1;
      if (dryRun) {
        console.error(
          JSON.stringify({
            cid: comment.cid,
            text: comment.text,
            error: error.message
          })
        );
      }
      continue;
    }
    const matchedResolutions = resolutions
      .filter((item) => item.matched && allowedCandidates.has(item.symbol))
      .map((item) => ({
        ...item,
        candidate: allowedCandidates.get(item.symbol)
      }));

    if (dryRun) {
      console.log(
        JSON.stringify(
          {
            cid: comment.cid,
            text: comment.text,
            candidates: candidates.map((item) => ({
              symbol: item.symbol,
              name: item.name,
              mention_text: item.mentionText,
              alias_type: item.aliasType
            })),
            resolutions: matchedResolutions
          },
          null,
          2
        )
      );
    }

    for (const item of matchedResolutions) {
      stats.matched += 1;
      const ambiguousMatch = matchedResolutions.some(
        (other) =>
          other !== item &&
          String(other.mentionText || "").toLowerCase() ===
            String(item.mentionText || "").toLowerCase() &&
          other.symbol !== item.symbol
      );
      if (ambiguousMatch) {
        stats.skippedAmbiguousCandidate += 1;
        continue;
      }
      if (item.confidence < minConfidence) {
        stats.skippedLowConfidence += 1;
        continue;
      }
      if (item.label !== "signal") {
        stats.rejectedContext += 1;
        if (!dryRun) {
          upsertCommentSignalLabel(db, {
            comment_cid: comment.cid,
            label: item.label,
            confidence: item.confidence,
            reason: item.reason,
            source: "abbreviation_agent",
            model: signalAgent?.model || ""
          });
        }
        continue;
      }
      if (!dryRun) {
        const stock = item.candidate;
        stats.created += upsertMention(db, comment, stock, item.mentionText);
        upsertCommentSignalLabel(db, {
          comment_cid: comment.cid,
          label: item.label,
          confidence: item.confidence,
          reason: item.reason,
          source: "abbreviation_agent",
          model: signalAgent?.model || ""
        });
        existingMentions.add(`${comment.cid}\t${stock.symbol}`);
      }
    }

    if (limit > 0 && stats.agentCalls >= limit) break;
  }

  stats.total = db.prepare("SELECT COUNT(*) AS count FROM stock_mentions").get().count;
  stats.resolvedAt = nowIso();
  return stats;
}
