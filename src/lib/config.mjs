import dotenv from "dotenv";
import path from "node:path";
import {
  DEFAULT_ACCOUNTS_PATH,
  DEFAULT_ALIASES_PATH,
  DEFAULT_DB_PATH,
  DEFAULT_DOUYIN_PROFILE_DIR,
  DEFAULT_REPORT_DIR,
  DEFAULT_TDX_KLINE_DIR,
  PROJECT_ROOT,
  readJson
} from "./common.mjs";

dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

export function getRuntimeConfig() {
  return {
    dbPath: path.resolve(process.env.DB_PATH || DEFAULT_DB_PATH),
    accountsPath: path.resolve(process.env.ACCOUNTS_PATH || DEFAULT_ACCOUNTS_PATH),
    aliasesPath: path.resolve(process.env.STOCK_ALIASES_PATH || DEFAULT_ALIASES_PATH),
    reportDir: path.resolve(process.env.REPORT_DIR || DEFAULT_REPORT_DIR),
    douyinProfileDir: path.resolve(process.env.DOUYIN_PROFILE_DIR || DEFAULT_DOUYIN_PROFILE_DIR),
    tdxKlineDir: path.resolve(process.env.TDX_KLINE_DIR || DEFAULT_TDX_KLINE_DIR),
    feishuWebhookUrl: String(process.env.FEISHU_WEBHOOK_URL || "").trim(),
    wechatWebhookUrl: String(process.env.WECHAT_WEBHOOK_URL || "").trim(),
    signalAgent: {
      endpoint: String(process.env.SIGNAL_AGENT_ENDPOINT || "").trim(),
      apiKey: String(process.env.SIGNAL_AGENT_API_KEY || "").trim(),
      model: String(process.env.SIGNAL_AGENT_MODEL || "").trim(),
      timeoutMs: Number(process.env.SIGNAL_AGENT_TIMEOUT_MS || 30000)
    },
    tonghuashun: {
      fuyaoAuthToken: String(process.env.THS_FUYAO_AUTH_TOKEN || "").trim(),
      fuyaoProjectId: String(process.env.THS_FUYAO_PROJECT_ID || "").trim()
    }
  };
}

export function loadAccounts({ account = "all", since = "" } = {}) {
  const config = getRuntimeConfig();
  const accounts = readJson(config.accountsPath, []);
  if (!Array.isArray(accounts)) {
    throw new Error(`Invalid accounts config: ${config.accountsPath}`);
  }

  const enabled = accounts.filter((item) => item.enabled !== false);
  const selected =
    !account || account === "all"
      ? enabled
      : enabled.filter((item) => item.account_id === account || item.sec_user_id === account);

  if (selected.length === 0) {
    throw new Error(`No enabled account matched: ${account}`);
  }

  return selected.map((item) => ({
    ...item,
    since_date: item.since_date || "1970-01-01",
    crawl_since_date: since || item.since_date || "1970-01-01",
    sec_user_id: item.sec_user_id || extractSecUserId(item.profile_url)
  }));
}

export function loadAliasConfig() {
  const config = getRuntimeConfig();
  const aliases = readJson(config.aliasesPath, []);
  if (!Array.isArray(aliases)) {
    throw new Error(`Invalid stock alias config: ${config.aliasesPath}`);
  }
  return aliases;
}

export function extractSecUserId(profileUrl = "") {
  const match = String(profileUrl).match(/\/user\/([^?/#]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}
