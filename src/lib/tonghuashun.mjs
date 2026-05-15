import { chunk, parseSymbol } from "./common.mjs";

const CODE_LOOKUP_URL =
  "http://zx.10jqka.com.cn/i/index/index/app/19/?stock_suffix=number&query=";
const SNAPSHOT_URL =
  "https://quota-h.10jqka.com.cn/fuyao/common_hq_aggr_cache/quote/v1/multi_last_snapshot";
const DEFAULT_PROJECT_ID = "hxkline-F10_StockInfoF10_page";

const MARKET_HINTS = {
  "17": "SH",
  "22": "SH",
  "33": "SZ",
  "48": "BJ"
};

const EXCHANGE_TO_MARKET = {
  SH: "17",
  SZ: "33",
  BJ: "48"
};

function normalizeLookupCandidate(value, rank, query) {
  const [code, marketRaw = ""] = String(value || "").split(".", 2);
  const exchange = MARKET_HINTS[marketRaw] || "";
  if (!/^\d{6}$/.test(code) || !exchange) return null;
  return {
    rank,
    code,
    exchange,
    symbol: `${code}.${exchange}`,
    query,
    source: "tonghuashun_code_lookup"
  };
}

export async function lookupCodes(query, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${CODE_LOOKUP_URL}${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const payload = await response.json();
    if (payload.errorcode !== 0) {
      throw new Error(`同花顺代码搜索失败: ${JSON.stringify(payload)}`);
    }
    const data = payload.result?.data || [];
    return data
      .map((item, index) => normalizeLookupCandidate(item, index + 1, query))
      .filter(Boolean);
  } finally {
    clearTimeout(timeout);
  }
}

function buildFuyaoCodeList(symbols) {
  const grouped = new Map();
  for (const value of symbols) {
    const parsed = parseSymbol(value);
    if (!parsed) continue;
    const market = EXCHANGE_TO_MARKET[parsed.exchange];
    if (!market) continue;
    if (!grouped.has(market)) grouped.set(market, []);
    grouped.get(market).push(parsed.code);
  }
  return [...grouped.entries()].map(([market, codes]) => ({ market, codes }));
}

function parseSnapshotItem(item) {
  const code = String(item.code || "");
  const market = String(item.market || "");
  const exchange = MARKET_HINTS[market] || "";
  const fields = item.data_fields || [];
  const row = item.value?.[0] || [];
  const mapped = {};
  fields.forEach((field, index) => {
    mapped[String(field)] = row[index];
  });
  return {
    code,
    exchange,
    symbol: exchange ? `${code}.${exchange}` : code,
    name: mapped["55"] || "",
    price: Number(mapped["10"]) || null,
    previous_close: Number(mapped["6"]) || null,
    open_price: Number(mapped["7"]) || null,
    high: Number(mapped["8"]) || null,
    low: Number(mapped["9"]) || null,
    percent_change: Number(mapped["199112"]) || null,
    source: "tonghuashun_fuyao_snapshot"
  };
}

export async function fetchFuyaoSnapshots(
  symbols,
  { batchSize = 200, timeoutMs = 15000, authToken = "", projectId = DEFAULT_PROJECT_ID } = {}
) {
  const results = [];
  if (!authToken) {
    return results;
  }
  for (const batch of chunk(symbols, batchSize)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const payload = {
        code_list: buildFuyaoCodeList(batch),
        trade_class: "intraday",
        data_fields: ["55", "6", "7", "8", "9", "10", "199112"],
        lang: "zh_cn",
        gpid: 0
      };
      if (payload.code_list.length === 0) continue;
      const response = await fetch(SNAPSHOT_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0",
          Referer: "https://eq.10jqka.com.cn/activepage/macPankou.html",
          "X-Fuyao-Auth": authToken,
          "Source-Id": projectId || DEFAULT_PROJECT_ID,
          Platform: "hxkline",
          "X-Auth-Type": "ths",
          "X-Auth-Version": "1.0",
          "X-Auth-ProgId": "7047",
          "X-Auth-AppName": "AINVEST"
        },
        body: JSON.stringify(payload)
      });
      const json = await response.json();
      if (json.status_code !== 0) {
        throw new Error(`Fuyao snapshot 接口异常: ${JSON.stringify(json)}`);
      }
      for (const item of json.data?.quote_data || []) {
        results.push(parseSnapshotItem(item));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  return results;
}
