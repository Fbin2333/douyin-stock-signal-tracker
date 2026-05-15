import fs from "node:fs";
import path from "node:path";
import {
  csvEscape,
  ensureDir,
  escapeHtml,
  formatPct,
  formatPoint,
  toShanghaiDateTimeFromUnixSeconds
} from "./common.mjs";

function queryStats(db) {
  return db
    .prepare(
      `
      SELECT
        s.*,
        a.display_name AS account_name
      FROM user_stats AS s
      JOIN accounts AS a ON a.account_id = s.account_id
      ORDER BY
        CASE s.tier WHEN 'elite' THEN 0 WHEN 'normal' THEN 1 WHEN 'ignored' THEN 2 ELSE 3 END,
        s.win_rate DESC,
        s.completed_mentions DESC,
        s.total_return_pct DESC
    `
    )
    .all();
}

function queryGlobalStats(db) {
  const rows = db
    .prepare(
      `
      SELECT *
      FROM user_stats_global
      ORDER BY
        CASE tier WHEN 'elite' THEN 0 WHEN 'normal' THEN 1 WHEN 'ignored' THEN 2 ELSE 3 END,
        win_rate DESC,
        completed_mentions DESC,
        total_return_pct DESC
    `
    )
    .all();
  const accountNames = new Map(
    db
      .prepare("SELECT account_id, display_name FROM accounts ORDER BY account_id")
      .all()
      .map((row) => [row.account_id, row.display_name])
  );
  return rows.map((row) => {
    const accountIds = parseJsonArray(row.account_ids_json);
    return {
      ...row,
      account_ids: accountIds,
      account_names: accountIds.map((accountId) => accountNames.get(accountId) || accountId)
    };
  });
}

function queryRecentMentions(db, limit = 200) {
  return db
    .prepare(
      `
      SELECT
        m.*,
        a.display_name AS account_name,
        c.text AS comment_text,
        v.desc AS video_desc,
        v.create_date AS video_create_date,
        e.status AS evaluation_status,
        e.max_close_return_pct,
        e.max_close_date
      FROM stock_mentions AS m
      JOIN accounts AS a ON a.account_id = m.account_id
      JOIN comments AS c ON c.cid = m.comment_cid
      LEFT JOIN videos AS v ON v.aweme_id = m.aweme_id
      LEFT JOIN evaluations AS e ON e.mention_id = m.id
      ORDER BY m.comment_time DESC
      LIMIT ?
    `
    )
    .all(limit);
}

export function generateReports(db, { reportDir }) {
  ensureDir(reportDir);
  const globalStats = queryGlobalStats(db);
  const stats = queryStats(db);
  const mentions = queryRecentMentions(db);
  const generatedAt = new Date().toISOString();

  const htmlPath = path.join(reportDir, "latest.html");
  const csvPath = path.join(reportDir, "latest.csv");
  const globalCsvPath = path.join(reportDir, "latest-global-users.csv");
  const mdPath = path.join(reportDir, "latest.md");

  fs.writeFileSync(htmlPath, renderHtml({ globalStats, stats, mentions, generatedAt }), "utf8");
  fs.writeFileSync(csvPath, renderCsv(stats), "utf8");
  fs.writeFileSync(globalCsvPath, renderGlobalCsv(globalStats), "utf8");
  fs.writeFileSync(mdPath, renderMarkdown({ globalStats, stats, mentions, generatedAt }), "utf8");

  return {
    htmlPath,
    csvPath,
    globalCsvPath,
    mdPath,
    globalStatsCount: globalStats.length,
    statsCount: stats.length,
    recentMentionCount: mentions.length
  };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function tierLabel(tier) {
  if (tier === "elite") return "重点";
  if (tier === "watch") return "观察";
  if (tier === "ignored") return "忽略";
  return "普通";
}

function renderHtml({ globalStats, stats, mentions, generatedAt }) {
  const globalRows = globalStats
    .map(
      (row) => `
        <tr data-tier="${escapeHtml(row.tier)}" data-account="${escapeHtml(row.account_ids.join(","))}">
          <td>${escapeHtml(tierLabel(row.tier))}</td>
          <td>${escapeHtml(row.account_count)}</td>
          <td>${escapeHtml(row.account_names.join(" / "))}</td>
          <td>${escapeHtml(row.user_nickname || row.user_stable_id)}</td>
          <td>${escapeHtml(row.user_stable_id)}</td>
          <td>${row.completed_mentions}</td>
          <td>${row.pending_mentions}</td>
          <td>${row.win_count}</td>
          <td>${formatPct(row.win_rate * 100)}</td>
          <td>${formatPoint(row.avg_return_pct)}</td>
          <td>${formatPoint(row.total_return_pct)}</td>
          <td>${formatPoint(row.max_return_pct)}</td>
          <td>${escapeHtml(row.latest_comment_time ? toShanghaiDateTimeFromUnixSeconds(row.latest_comment_time) : "")}</td>
        </tr>`
    )
    .join("");

  const statRows = stats
    .map(
      (row) => `
        <tr data-tier="${escapeHtml(row.tier)}" data-account="${escapeHtml(row.account_id)}">
          <td>${escapeHtml(tierLabel(row.tier))}</td>
          <td>${escapeHtml(row.account_name)}</td>
          <td>${escapeHtml(row.user_nickname || row.user_stable_id)}</td>
          <td>${escapeHtml(row.user_stable_id)}</td>
          <td>${row.completed_mentions}</td>
          <td>${row.pending_mentions}</td>
          <td>${row.win_count}</td>
          <td>${formatPct(row.win_rate * 100)}</td>
          <td>${formatPoint(row.avg_return_pct)}</td>
          <td>${formatPoint(row.total_return_pct)}</td>
          <td>${formatPoint(row.max_return_pct)}</td>
          <td>${escapeHtml(row.latest_comment_time ? toShanghaiDateTimeFromUnixSeconds(row.latest_comment_time) : "")}</td>
        </tr>`
    )
    .join("");

  const mentionRows = mentions
    .map(
      (row) => `
        <tr data-account="${escapeHtml(row.account_id)}">
          <td>${escapeHtml(row.account_name)}</td>
          <td>${escapeHtml(row.user_nickname || row.user_stable_id)}</td>
          <td>${escapeHtml(row.stock_name || row.symbol)}</td>
          <td>${escapeHtml(row.symbol)}</td>
          <td>${escapeHtml(row.video_create_date || "")}</td>
          <td>${escapeHtml(row.comment_date || "")}</td>
          <td>${escapeHtml(row.evaluation_status || "")}</td>
          <td>${formatPoint(row.max_close_return_pct)}</td>
          <td>${escapeHtml(row.comment_text || "")}</td>
        </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Douyin Stock Signal Tracker</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #17202a; background: #f7f8fa; }
    h1, h2 { margin: 0 0 12px; }
    h2 { margin-top: 28px; }
    .toolbar { display: flex; gap: 8px; margin: 16px 0; }
    input, select { padding: 8px 10px; border: 1px solid #cfd6df; border-radius: 6px; background: white; }
    table { border-collapse: collapse; width: 100%; background: white; border: 1px solid #dfe5ec; }
    th, td { padding: 8px 10px; border-bottom: 1px solid #edf0f4; text-align: left; vertical-align: top; font-size: 13px; }
    th { background: #eef3f8; font-weight: 700; position: sticky; top: 0; }
    tr[data-tier="elite"] td:first-child { color: #b42318; font-weight: 700; }
    tr[data-tier="watch"] td:first-child { color: #9a6700; font-weight: 700; }
    tr[data-tier="ignored"] td:first-child { color: #5d6b7a; font-weight: 700; }
    .muted { color: #5d6b7a; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Douyin Stock Signal Tracker</h1>
  <div class="muted">Generated at ${escapeHtml(generatedAt)}</div>
  <div class="toolbar">
    <input id="filter" placeholder="筛选账号 / 用户 / 股票 / 评论" />
    <select id="tier">
      <option value="">全部层级</option>
      <option value="elite">重点</option>
      <option value="watch">观察</option>
      <option value="normal">普通</option>
      <option value="ignored">忽略</option>
    </select>
  </div>

  <h2>跨账号用户汇总</h2>
  <table id="global-stats">
    <thead>
      <tr><th>层级</th><th>账号数</th><th>出现账号</th><th>用户</th><th>稳定 ID</th><th>完成</th><th>Pending</th><th>命中</th><th>胜率</th><th>平均收益</th><th>累计收益</th><th>最大收益</th><th>最近评论</th></tr>
    </thead>
    <tbody>${globalRows}</tbody>
  </table>

  <h2>账号内用户胜率</h2>
  <table id="stats">
    <thead>
      <tr><th>层级</th><th>账号</th><th>用户</th><th>稳定 ID</th><th>完成</th><th>Pending</th><th>命中</th><th>胜率</th><th>平均收益</th><th>累计收益</th><th>最大收益</th><th>最近评论</th></tr>
    </thead>
    <tbody>${statRows}</tbody>
  </table>

  <h2>最近股票提及</h2>
  <table id="mentions">
    <thead>
      <tr><th>账号</th><th>用户</th><th>股票</th><th>代码</th><th>视频日期</th><th>评论日期</th><th>状态</th><th>收益</th><th>评论</th></tr>
    </thead>
    <tbody>${mentionRows}</tbody>
  </table>

  <script>
    const filter = document.querySelector("#filter");
    const tier = document.querySelector("#tier");
    const apply = () => {
      const text = filter.value.trim().toLowerCase();
      const tierValue = tier.value;
      for (const row of document.querySelectorAll("tbody tr")) {
        const matchesText = !text || row.innerText.toLowerCase().includes(text);
        const matchesTier = !tierValue || row.dataset.tier === tierValue || !row.dataset.tier;
        row.style.display = matchesText && matchesTier ? "" : "none";
      }
    };
    filter.addEventListener("input", apply);
    tier.addEventListener("change", apply);
  </script>
</body>
</html>`;
}

function renderCsv(stats) {
  const headers = [
    "tier",
    "account_id",
    "account_name",
    "user_stable_id",
    "user_nickname",
    "completed_mentions",
    "pending_mentions",
    "win_count",
    "win_rate",
    "avg_return_pct",
    "total_return_pct",
    "max_return_pct",
    "latest_comment_time"
  ];
  const lines = [headers.join(",")];
  for (const row of stats) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function renderGlobalCsv(globalStats) {
  const headers = [
    "tier",
    "account_count",
    "account_ids",
    "account_names",
    "user_stable_id",
    "user_nickname",
    "completed_mentions",
    "pending_mentions",
    "win_count",
    "win_rate",
    "avg_return_pct",
    "total_return_pct",
    "max_return_pct",
    "latest_comment_time"
  ];
  const lines = [headers.join(",")];
  for (const row of globalStats) {
    const values = {
      ...row,
      account_ids: row.account_ids.join("|"),
      account_names: row.account_names.join("|")
    };
    lines.push(headers.map((header) => csvEscape(values[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function renderMarkdown({ globalStats, stats, mentions, generatedAt }) {
  const globalTop = globalStats.slice(0, 50);
  const globalRows = globalTop
    .map(
      (row) =>
        `| ${tierLabel(row.tier)} | ${row.account_count} | ${row.account_names.join(" / ")} | ${row.user_nickname || row.user_stable_id} | ${row.completed_mentions} | ${row.pending_mentions} | ${formatPct(row.win_rate * 100)} | ${formatPoint(row.avg_return_pct)} | ${formatPoint(row.total_return_pct)} |`
    )
    .join("\n");
  const top = stats.slice(0, 50);
  const statRows = top
    .map(
      (row) =>
        `| ${tierLabel(row.tier)} | ${row.account_name} | ${row.user_nickname || row.user_stable_id} | ${row.completed_mentions} | ${row.pending_mentions} | ${formatPct(row.win_rate * 100)} | ${formatPoint(row.avg_return_pct)} | ${formatPoint(row.total_return_pct)} |`
    )
    .join("\n");
  const mentionRows = mentions
    .slice(0, 50)
    .map(
      (row) =>
        `| ${row.account_name} | ${row.user_nickname || row.user_stable_id} | ${row.stock_name || row.symbol} | ${row.video_create_date || ""} | ${row.comment_date || ""} | ${row.evaluation_status || ""} | ${formatPoint(row.max_close_return_pct)} | ${String(row.comment_text || "").replace(/\|/g, " ")} |`
    )
    .join("\n");
  return `# Douyin Stock Signal Tracker

Generated at: ${generatedAt}

## 跨账号用户汇总

| 层级 | 账号数 | 出现账号 | 用户 | 完成 | Pending | 胜率 | 平均收益 | 累计收益 |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
${globalRows}

## 用户胜率

| 层级 | 账号 | 用户 | 完成 | Pending | 胜率 | 平均收益 | 累计收益 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
${statRows}

## 最近股票提及

| 账号 | 用户 | 股票 | 视频日期 | 评论日期 | 状态 | 收益 | 评论 |
| --- | --- | --- | --- | --- | --- | ---: | --- |
${mentionRows}
`;
}
