#!/usr/bin/env node

import { getRuntimeConfig } from "../src/lib/config.mjs";
import { postFeishu } from "../src/lib/alerts.mjs";

const [status = "notice", ...detailParts] = process.argv.slice(2);
const detail = detailParts.join(" ").trim();
const config = getRuntimeConfig();

const text = [
  "【抖音股票监控｜状态通知】",
  `状态：${status}`,
  `时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`,
  detail ? `细节：${detail}` : ""
]
  .filter(Boolean)
  .join("\n");

if (!config.feishuWebhookUrl) {
  console.log(JSON.stringify({ sent: false, reason: "feishu_webhook_missing", text }, null, 2));
  process.exit(0);
}

try {
  await postFeishu(config.feishuWebhookUrl, text);
  console.log(JSON.stringify({ sent: true, channel: "feishu" }, null, 2));
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}
