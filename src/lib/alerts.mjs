import { getPendingAlertMentions } from "./db.mjs";
import { formatPct, formatPoint, nowIso } from "./common.mjs";

export function buildAlertMessage(row) {
  const winRate = formatPct(Number(row.win_rate || 0) * 100);
  const avgReturn = formatPoint(row.avg_return_pct);
  const globalLine =
    Number(row.global_completed_mentions || 0) > Number(row.completed_mentions || 0) ||
    Number(row.global_account_count || 0) > 1
      ? `跨账号：覆盖 ${row.global_account_count || 1} 个账号，${row.global_completed_mentions || 0} 次完成，命中 ${row.global_win_count || 0} 次，胜率 ${formatPct(Number(row.global_win_rate || 0) * 100)}，平均收益 ${formatPoint(row.global_avg_return_pct)}`
      : "";
  return [
    "【抖音股票提及提醒｜高胜率用户】",
    `账号：${row.account_name}`,
    `用户：${row.user_nickname || row.user_stable_id}`,
    `历史：${row.completed_mentions} 次完成，命中 ${row.win_count} 次，胜率 ${winRate}，平均收益 ${avgReturn}`,
    globalLine,
    `新提及：${row.stock_name || row.symbol} (${row.symbol})`,
    `视频日期：${row.video_create_date || ""}`,
    `评论日期：${row.comment_date || ""}`,
    `视频：${row.video_desc || row.aweme_id}`,
    `原话：${row.comment_text}`
  ].filter(Boolean).join("\n");
}

export function previewAlerts(db) {
  return getPendingAlertMentions(db).map((row) => ({
    mention_id: row.id,
    alert_type: row.global_tier === "elite" ? "global_elite" : row.tier,
    message: buildAlertMessage(row),
    row
  }));
}

export function queueAlerts(db) {
  const previews = previewAlerts(db);
  const insert = db.prepare(
    `
    INSERT OR IGNORE INTO alerts (
      mention_id, account_id, user_stable_id, alert_type, status, message, channels_json, created_at
    )
    VALUES (?, ?, ?, ?, 'pending', ?, '[]', ?)
  `
  );
  let queued = 0;
  for (const item of previews) {
    const result = insert.run(
      item.mention_id,
      item.row.account_id,
      item.row.user_stable_id,
      item.alert_type,
      item.message,
      nowIso()
    );
    queued += result.changes;
  }
  return { queued, previews };
}

export async function sendPendingAlerts(db, { feishuWebhookUrl = "", wechatWebhookUrl = "" } = {}) {
  const alerts = db
    .prepare("SELECT * FROM alerts WHERE status='pending' ORDER BY created_at ASC")
    .all();
  let sent = 0;
  let localOnly = 0;
  let failed = 0;

  for (const alert of alerts) {
    const channels = [];
    const errors = [];
    if (feishuWebhookUrl) {
      try {
        await postFeishu(feishuWebhookUrl, alert.message);
        channels.push("feishu");
      } catch (error) {
        errors.push(`feishu: ${error.message}`);
      }
    }
    if (wechatWebhookUrl) {
      try {
        await postWeChat(wechatWebhookUrl, alert.message);
        channels.push("wechat");
      } catch (error) {
        errors.push(`wechat: ${error.message}`);
      }
    }

    if (!feishuWebhookUrl && !wechatWebhookUrl) {
      db.prepare(
        "UPDATE alerts SET status='local_only', sent_at=?, channels_json=? WHERE id=?"
      ).run(nowIso(), "[]", alert.id);
      localOnly += 1;
      continue;
    }

    if (errors.length > 0 && channels.length === 0) {
      db.prepare("UPDATE alerts SET status='failed', error=? WHERE id=?").run(
        errors.join("; "),
        alert.id
      );
      failed += 1;
      continue;
    }

    db.prepare(
      "UPDATE alerts SET status='sent', sent_at=?, channels_json=?, error=? WHERE id=?"
    ).run(nowIso(), JSON.stringify(channels), errors.join("; "), alert.id);
    sent += 1;
  }

  return { pending: alerts.length, sent, localOnly, failed };
}

export async function postFeishu(url, text) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msg_type: "text",
      content: { text }
    })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${body}`);
  }
  const payload = parseJsonBody(body);
  const code = payload?.code ?? payload?.StatusCode;
  if (code !== undefined && Number(code) !== 0) {
    const message = payload?.msg || payload?.StatusMessage || body;
    throw new Error(`Feishu ${code}: ${message}`);
  }
}

async function postWeChat(url, text) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "text",
      text: { content: text }
    })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
}

function parseJsonBody(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
