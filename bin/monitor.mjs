#!/usr/bin/env node

import { getDb } from "../src/lib/db.mjs";
import { getRuntimeConfig, loadAccounts } from "../src/lib/config.mjs";
import { crawlAccounts, summarizeCrawlResults } from "../src/lib/douyin-crawler.mjs";
import { evaluateAll } from "../src/lib/evaluator.mjs";
import { generateReports } from "../src/lib/report.mjs";
import { postFeishu, queueAlerts, sendPendingAlerts } from "../src/lib/alerts.mjs";
import { boolArg, intArg, parseArgs } from "../src/lib/cli.mjs";
import { PROJECT_ROOT, nowIso, writeJson } from "../src/lib/common.mjs";
import { resolveAbbreviationsForAllComments } from "../src/lib/abbreviation-resolver.mjs";
import { detectRiskControl } from "../src/lib/monitor-risk.mjs";
import path from "node:path";

function buildReviewQueue({ queued, sent, result }) {
  const reviewRequired = queued.queued > 0 || sent.sent > 0 || sent.localOnly > 0 || sent.failed > 0;
  return {
    updated_at: nowIso(),
    review_required: reviewRequired,
    reasons: [
      queued.queued > 0 ? "new_high_win_alerts_queued" : "",
      sent.sent > 0 ? "high_win_alerts_sent" : "",
      sent.localOnly > 0 ? "alerts_local_only_webhook_missing" : "",
      sent.failed > 0 ? "alert_delivery_failed" : ""
    ].filter(Boolean),
    summary: {
      alerts: {
        queued: queued.queued,
        pending_processed: sent.pending,
        sent: sent.sent,
        local_only: sent.localOnly,
        failed: sent.failed
      },
      crawl: result.crawl,
      evaluation: result.evaluation
    },
    alert_previews: queued.previews.slice(0, 20).map((item) => ({
      mention_id: item.mention_id,
      alert_type: item.alert_type,
      account_id: item.row.account_id,
      user_stable_id: item.row.user_stable_id,
      user_nickname: item.row.user_nickname,
      symbol: item.row.symbol,
      stock_name: item.row.stock_name,
      comment_date: item.row.comment_date,
      video_date: item.row.video_create_date,
      message: item.message
    })),
    codex_next_step: reviewRequired
      ? "Inspect alert_previews and latest report. If an alert looks like consultation/post_hoc noise, run semantic classification before trusting it."
      : "No Codex review needed."
  };
}

function buildProbeQueue(result) {
  return {
    updated_at: nowIso(),
    review_required: false,
    reasons: [],
    summary: {
      probe: result.probe,
      crawl: result.crawl,
      alerts: {
        queued: 0,
        pending_processed: 0,
        sent: 0,
        local_only: 0,
        failed: 0
      }
    },
    alert_previews: [],
    codex_next_step: "Probe-only monitor run completed. No alert review needed."
  };
}

async function notifyMonitorPause(config, { account, crawl, reason, detail, requiresManualVerification }) {
  if (!config.feishuWebhookUrl) return { sent: false, reason: "feishu_webhook_missing" };
  const title = requiresManualVerification ? "【抖音股票监控｜需要人工验证】" : "【抖音股票监控｜冷却暂停】";
  const action = requiresManualVerification
    ? "我已暂停自动监控。请手动打开抖音完成验证，确认后再恢复低频监控。"
    : "未检测到明确验证码；更像短期请求过多或评论接口临时限流。我已暂停自动监控做冷却，避免继续加压。";
  const text = [
    title,
    `状态：${reason}`,
    `账号：${account || "all"}`,
    `时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`,
    detail ? `细节：${detail}` : "",
    crawl ? `抓取：目标视频 ${crawl.videos_targeted || 0}，失败 ${crawl.videos_failed || 0}，新增评论 ${crawl.comments_new || 0}` : "",
    action
  ]
    .filter(Boolean)
    .join("\n");
  await postFeishu(config.feishuWebhookUrl, text);
  return { sent: true, channel: "feishu" };
}

async function writeMonitorPauseState({
  config,
  account,
  crawl,
  reason,
  detail,
  stateReason,
  requiresManualVerification
}) {
  const updatedAt = nowIso();
  const notification = await notifyMonitorPause(config, {
    account,
    crawl,
    reason,
    detail,
    requiresManualVerification
  }).catch((error) => ({
    sent: false,
    reason: error.message
  }));
  const failure = {
    reason: stateReason || "monitor_paused_for_douyin_rate_limit",
    detail: [reason, detail].filter(Boolean).join("; "),
    notification,
    updated_at: updatedAt
  };
  const result = {
    updated_at: updatedAt,
    ok: false,
    failure,
    crawl: crawl || null,
    alerts: {
      queued: 0,
      pending: 0,
      sent: 0,
      localOnly: 0,
      failed: 0
    }
  };
  writeJson(path.join(PROJECT_ROOT, "data/latest-monitor-result.json"), result);
  writeJson(path.join(PROJECT_ROOT, "data/codex-review-queue.json"), {
    updated_at: updatedAt,
    review_required: true,
    reasons: [stateReason || "monitor_paused_for_douyin_rate_limit"],
    summary: {
      failure,
      crawl: crawl || null,
      alerts: {
        queued: 0,
        pending_processed: 0,
        sent: 0,
        local_only: 0,
        failed: 0
      }
    },
    alert_previews: [],
    codex_next_step: requiresManualVerification
      ? "Douyin verification was detected. Keep launchd monitor paused until the profile is manually verified, then resume with low-frequency schedules only."
      : "Douyin comment reads look rate-limited or temporarily empty. Keep launchd monitor paused for cooldown; manual verification is not required unless the browser shows a verification page."
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { account: "all" });
  const config = getRuntimeConfig();
  const db = getDb();
  const accounts = loadAccounts({
    account: args.account || "all",
    since: args.since || ""
  });
  const monitorStartedAt = nowIso();

  let crawlResults = [];
  try {
    crawlResults = await crawlAccounts(db, accounts, {
      profileDir: args.profileDir || config.douyinProfileDir,
      headless: boolArg(args, "headless", true),
      noReplies: boolArg(args, "replies", true) === false || boolArg(args, "noReplies", false),
      maxVideos: intArg(args, "maxVideos", 0),
      maxProfileScrolls: intArg(args, "maxProfileScrolls", 160),
      maxProfilePages: intArg(args, "maxProfilePages", 0),
      maxCommentPages: intArg(args, "maxCommentPages", 0),
      maxCommentScrolls: intArg(args, "maxCommentScrolls", 0),
      maxReplyClicksPerLoop: intArg(args, "maxReplyClicksPerLoop", 8),
      videoTimeoutMs: intArg(args, "videoTimeoutMs", 45000)
    });
  } catch (error) {
    const risk = detectRiskControl(null, error);
    if (risk) {
      await writeMonitorPauseState({
        config,
        account: args.account || "all",
        crawl: null,
        ...risk
      });
      process.exitCode = 86;
      return;
    }
    throw error;
  }
  const crawl = summarizeCrawlResults(crawlResults);
  const risk = detectRiskControl(crawl);
  if (risk) {
    await writeMonitorPauseState({
      config,
      account: args.account || "all",
      crawl,
      ...risk
    });
    process.exitCode = 86;
    return;
  }
  if (boolArg(args, "probe", false)) {
    const commentsSeen = Number(crawl.top_comments_seen || 0) + Number(crawl.reply_comments_seen || 0);
    const result = {
      crawl,
      probe: {
        ok: true,
        validated: Number(crawl.videos_targeted || 0) > 0 && commentsSeen > 0,
        comments_seen: commentsSeen
      },
      alerts: { queued: 0, pending: 0, sent: 0, localOnly: 0, failed: 0 }
    };
    writeJson(path.join(PROJECT_ROOT, "data/latest-monitor-result.json"), {
      updated_at: nowIso(),
      ...result
    });
    writeJson(path.join(PROJECT_ROOT, "data/codex-review-queue.json"), buildProbeQueue(result));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const abbreviationResolution =
    config.signalAgent.endpoint && config.signalAgent.apiKey && config.signalAgent.model
      ? await resolveAbbreviationsForAllComments(db, {
          signalAgent: config.signalAgent,
          since: args.since || "",
          firstSeenSince: monitorStartedAt,
          limit: intArg(args, "abbreviationLimit", 0)
        })
      : { skipped: "signal_agent_not_configured" };
  const evaluation = evaluateAll(db, { tdxKlineDir: config.tdxKlineDir });
  const report = generateReports(db, { reportDir: config.reportDir });
  const queued = queueAlerts(db);
  const sent = await sendPendingAlerts(db, {
    feishuWebhookUrl: config.feishuWebhookUrl,
    wechatWebhookUrl: config.wechatWebhookUrl
  });

  const result = {
    crawl,
    abbreviationResolution,
    evaluation,
    report,
    alerts: { queued: queued.queued, ...sent }
  };
  writeJson(path.join(PROJECT_ROOT, "data/latest-monitor-result.json"), {
    updated_at: nowIso(),
    ...result
  });
  writeJson(
    path.join(PROJECT_ROOT, "data/codex-review-queue.json"),
    buildReviewQueue({ queued, sent, result })
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
