import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

export const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "data/douyin-stock-signals.db");
export const DEFAULT_ACCOUNTS_PATH = path.join(PROJECT_ROOT, "config/accounts.json");
export const DEFAULT_ALIASES_PATH = path.join(PROJECT_ROOT, "config/stock-aliases.json");
export const DEFAULT_REPORT_DIR = path.join(PROJECT_ROOT, "reports");
export const DEFAULT_DOUYIN_PROFILE_DIR = path.join(PROJECT_ROOT, ".playwright/douyin-profile");
export const DEFAULT_TDX_KLINE_DIR = path.join(PROJECT_ROOT, "data/tdx/kline");

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function normalizeText(value = "") {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/\u200b/g, "")
    .trim();
}

export function normalizeSearchText(value = "") {
  return normalizeText(value)
    .replace(/[【】()[\]（）《》<>「」『』“”"'`·•|｜,，.。:：;；!?！？#＃]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toDateStringFromUnixSeconds(seconds) {
  if (!seconds) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(Number(seconds) * 1000));
}

export function toIsoFromUnixSeconds(seconds) {
  if (!seconds) return "";
  return new Date(Number(seconds) * 1000).toISOString();
}

export function toShanghaiDateTimeFromUnixSeconds(seconds) {
  if (!seconds) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(Number(seconds) * 1000));
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function toPositiveInteger(value, name, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

export function stableUserId(comment) {
  return (
    comment.user_sec_uid ||
    comment.user_uid ||
    comment.user_unique_id ||
    comment.user_short_id ||
    comment.user_nickname ||
    "unknown"
  );
}

export function inferExchange(code) {
  const raw = String(code || "").trim();
  if (/^(6|9)\d{5}$/.test(raw)) return "SH";
  if (/^(0|2|3)\d{5}$/.test(raw)) return "SZ";
  if (/^(4|8)\d{5}$/.test(raw)) return "BJ";
  return "";
}

export function symbolFromCode(code) {
  const exchange = inferExchange(code);
  return exchange ? `${code}.${exchange}` : String(code || "");
}

export function parseSymbol(symbolOrCode) {
  const value = String(symbolOrCode || "").trim().toUpperCase();
  const match = value.match(/^(\d{6})(?:\.(SH|SZ|BJ))?$/);
  if (!match) return null;
  const code = match[1];
  const exchange = match[2] || inferExchange(code);
  if (!exchange) return null;
  return { code, exchange, symbol: `${code}.${exchange}` };
}

export function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function formatPct(value) {
  if (value == null || Number.isNaN(Number(value))) return "";
  return `${Number(value).toFixed(2)}%`;
}

export function formatPoint(value) {
  if (value == null || Number.isNaN(Number(value))) return "";
  return `${Number(value).toFixed(2)} 点`;
}

export function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
