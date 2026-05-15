import { nowIso, toDateStringFromUnixSeconds } from "./common.mjs";
import { refreshUserStats, syncMentionCommentFields, upsertEvaluation } from "./db.mjs";
import { readTdxBars } from "./stock-data.mjs";
import { extractMentionsForAllComments } from "./mentions.mjs";

export function evaluateMention(mention, bars) {
  const commentDate =
    mention.comment_date || toDateStringFromUnixSeconds(mention.comment_time);
  if (!commentDate) {
    return {
      mention_id: mention.id,
      status: "invalid_time",
      baseline_date: null,
      baseline_open: null,
      window_start_date: null,
      window_end_date: null,
      max_close: null,
      max_close_date: null,
      max_close_return_pct: null,
      is_win: null,
      window: []
    };
  }

  if (!bars.length) {
    return {
      mention_id: mention.id,
      status: "no_bars",
      baseline_date: null,
      baseline_open: null,
      window_start_date: null,
      window_end_date: null,
      max_close: null,
      max_close_date: null,
      max_close_return_pct: null,
      is_win: null,
      window: []
    };
  }

  const baselineIndex = bars.findIndex((bar) => bar.date > commentDate);
  if (baselineIndex < 0) {
    return {
      mention_id: mention.id,
      status: "pending",
      baseline_date: null,
      baseline_open: null,
      window_start_date: null,
      window_end_date: null,
      max_close: null,
      max_close_date: null,
      max_close_return_pct: null,
      is_win: null,
      window: []
    };
  }

  const window = bars.slice(baselineIndex, baselineIndex + 4);
  const baseline = window[0];
  if (window.length < 4) {
    return {
      mention_id: mention.id,
      status: "pending",
      baseline_date: baseline.date,
      baseline_open: baseline.open,
      window_start_date: baseline.date,
      window_end_date: window.at(-1)?.date || baseline.date,
      max_close: null,
      max_close_date: null,
      max_close_return_pct: null,
      is_win: null,
      window
    };
  }

  const best = window.reduce((currentBest, bar) =>
    Number(bar.close) > Number(currentBest.close) ? bar : currentBest
  );
  const maxCloseReturnPct = ((best.close - baseline.open) / baseline.open) * 100;
  return {
    mention_id: mention.id,
    status: "completed",
    baseline_date: baseline.date,
    baseline_open: baseline.open,
    window_start_date: baseline.date,
    window_end_date: window.at(-1).date,
    max_close: best.close,
    max_close_date: best.date,
    max_close_return_pct: maxCloseReturnPct,
    is_win: maxCloseReturnPct > 0 ? 1 : 0,
    window: window.map((bar) => ({
      ...bar,
      close_return_pct: ((bar.close - baseline.open) / baseline.open) * 100
    }))
  };
}

export function evaluateAll(db, { tdxKlineDir, extractMentions = true } = {}) {
  let mentionResult = null;
  if (extractMentions) {
    mentionResult = extractMentionsForAllComments(db);
  }
  const syncedMentions = syncMentionCommentFields(db);

  const mentions = db
    .prepare(
      `
      SELECT *
      FROM stock_mentions
      ORDER BY comment_time ASC, id ASC
    `
    )
    .all();
  let completed = 0;
  let pending = 0;
  let noBars = 0;

  for (const mention of mentions) {
    const bars = readTdxBars(tdxKlineDir, mention.symbol);
    const evaluation = evaluateMention(mention, bars);
    evaluation.evaluated_at = nowIso();
    upsertEvaluation(db, evaluation);
    if (evaluation.status === "completed") completed += 1;
    else if (evaluation.status === "pending") pending += 1;
    else noBars += 1;
  }

  refreshUserStats(db);

  return {
    mentions: mentionResult,
    syncedMentions,
    evaluated: mentions.length,
    completed,
    pending,
    noBars
  };
}
