import { normalizeSearchText, parseSymbol, stableUserId, symbolFromCode } from "./common.mjs";
import { getDictionaryTerms } from "./stock-data.mjs";
import {
  deleteMentionsForComment,
  getCommentSignalLabel,
  getIgnoredUserKeys,
  upsertMention,
  upsertStock
} from "./db.mjs";

const CODE_RE = /(?<!\d)([03689]\d{5}|[48]\d{5})(?!\d)/g;
const QUESTION_MARK_RE = /[?？]/;
const CONSULTATION_RE =
  /(请问|问下|问一下|老师|大哥|哥[，, ]|帮我|帮忙|看看|看一下|怎么看|咋看|怎么操作|怎么办|能不能|可不可以|可以.*吗|能.*吗|要不要|该不该|适合.*吗|追不追|能追.*吗|能入.*吗|能进.*吗|能买吗|能上车.*吗|能拿.*吗|拿着.*吗|持有.*吗|套了|被套|解套|亏了|割肉|卖不卖|要卖.*吗|补仓.*吗|加仓.*吗|还有机会.*吗|明天会.*吗|会不会|是不是|咋办|求看|求问)/;
const POST_HOC_RE =
  /(我.*(推荐过|说过|讲过|提过|喊过|叫过|推过)|我.*(推荐|说|讲|提|喊|叫|推).*的|之前.*(推荐|说|讲|提|喊|叫|推)|早就.*(推荐|说|讲|提|喊|叫|推)|(前几天|几天前|前天|昨天|上周|上月).*(推荐|说|讲|提|喊|叫|推|说了|讲了|提了|喊了|叫了|推了)|\d{1,2}[号日].*(推荐|说|讲|提|喊|叫|推)|没买[吗嘛么]?|没跟[吗嘛么]?|你没买|你没跟|都涨了|已经涨|吃肉了|涨停了吧|起飞了吧|验证了)/;
const AFFIRMATIVE_RE =
  /(关注|看好|看多|看涨|低吸|埋伏|潜伏|上车|闭眼入|可以买|买入|入场|进场|拿住|持有|格局|冲|干|搞|盯|明天看|后面|还有戏|目标|涨停|反包|突破|启动|机会|主线|龙头)/;

function compactForContext(text) {
  return String(text || "").replace(/\s+/g, "");
}

export function classifyMentionContext(text) {
  const compactText = compactForContext(text);
  if (!compactText) {
    return {
      label: "chat",
      isSignal: false,
      reason: "empty",
      confidence: 1,
      needsAgent: false
    };
  }

  if (POST_HOC_RE.test(compactText)) {
    return {
      label: "post_hoc",
      isSignal: false,
      reason: "post_hoc_reference",
      confidence: 0.9,
      needsAgent: false
    };
  }

  if (CONSULTATION_RE.test(compactText)) {
    return {
      label: "consultation",
      isSignal: false,
      reason: "consultation_or_position_question",
      confidence: 0.86,
      needsAgent: false
    };
  }

  if (QUESTION_MARK_RE.test(compactText) && !AFFIRMATIVE_RE.test(compactText)) {
    return {
      label: "consultation",
      isSignal: false,
      reason: "question_without_signal_cue",
      confidence: 0.78,
      needsAgent: false
    };
  }

  return {
    label: "signal",
    isSignal: true,
    reason: QUESTION_MARK_RE.test(compactText)
      ? "signal_with_question_mark"
      : "stock_mention_signal",
    confidence: QUESTION_MARK_RE.test(compactText) ? 0.58 : 0.68,
    needsAgent: QUESTION_MARK_RE.test(compactText)
  };
}

function labelToContext(labelRow, fallback) {
  if (!labelRow) return fallback;
  const label = String(labelRow.label || "").trim();
  return {
    label,
    isSignal: label === "signal",
    reason: labelRow.reason || `stored_${label}`,
    confidence: labelRow.confidence,
    needsAgent: false,
    source: labelRow.source || "stored"
  };
}

export function extractRawStockMentions(text, dictionaryTerms) {
  const found = new Map();
  const rawText = String(text || "");
  const normalizedText = normalizeSearchText(rawText).toUpperCase();

  for (const term of dictionaryTerms) {
    if (!term.term || term.term.length < 2) continue;
    const needle = term.normalized;
    if (needle.length < 2) continue;
    if (normalizedText.includes(needle)) {
      found.set(term.stock.symbol, {
        ...term.stock,
        mentionText: term.term
      });
    }
  }

  for (const match of rawText.matchAll(CODE_RE)) {
    const parsed = parseSymbol(match[1]) || parseSymbol(symbolFromCode(match[1]));
    if (!parsed) continue;
    found.set(parsed.symbol, {
      symbol: parsed.symbol,
      code: parsed.code,
      exchange: parsed.exchange,
      name: parsed.code,
      mentionText: match[1]
    });
  }

  return [...found.values()];
}

export function extractStockMentions(text, dictionaryTerms) {
  const mentions = extractRawStockMentions(text, dictionaryTerms);
  if (mentions.length === 0) return mentions;
  const context = classifyMentionContext(text);
  return context.isSignal ? mentions : [];
}

export function extractMentionsForAllComments(db) {
  const dictionaryTerms = getDictionaryTerms(db);
  const ignoredUsers = getIgnoredUserKeys(db);
  const comments = db
    .prepare(
      `
      SELECT *
      FROM comments
      ORDER BY create_time ASC, cid ASC
    `
    )
    .all();

  let created = 0;
  let scanned = 0;
  let skippedIgnored = 0;
  let skippedContext = 0;
  let deletedRejected = 0;
  for (const comment of comments) {
    scanned += 1;
    if (ignoredUsers.has(`${comment.account_id}\t${stableUserId(comment)}`)) {
      skippedIgnored += 1;
      continue;
    }
    const rawMentions = extractRawStockMentions(comment.text, dictionaryTerms);
    if (rawMentions.length === 0) {
      continue;
    }
    const context = labelToContext(
      getCommentSignalLabel(db, comment.cid),
      classifyMentionContext(comment.text)
    );
    if (!context.isSignal) {
      skippedContext += rawMentions.length;
      deletedRejected += deleteMentionsForComment(db, comment.cid);
      continue;
    }
    const mentions = rawMentions;
    for (const mention of mentions) {
      upsertStock(db, {
        symbol: mention.symbol,
        code: mention.code,
        exchange: mention.exchange,
        name: mention.name,
        aliases: [mention.name, mention.mentionText, mention.code, mention.symbol],
        source: "mention_code"
      });
      created += upsertMention(db, comment, mention, mention.mentionText);
    }
  }

  return {
    scanned,
    created,
    skippedIgnored,
    skippedContext,
    deletedRejected,
    total: db.prepare("SELECT COUNT(*) AS count FROM stock_mentions").get().count
  };
}
