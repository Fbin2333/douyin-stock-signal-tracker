import fs from "node:fs";
import path from "node:path";
import { inferExchange, parseSymbol, readJson, symbolFromCode } from "./common.mjs";
import { upsertStock } from "./db.mjs";
import { loadAliasConfig } from "./config.mjs";
import { fetchFuyaoSnapshots, lookupCodes } from "./tonghuashun.mjs";

export function listTdxSymbols(tdxKlineDir) {
  if (!fs.existsSync(tdxKlineDir)) {
    throw new Error(`TDX kline dir not found: ${tdxKlineDir}`);
  }
  return fs
    .readdirSync(tdxKlineDir)
    .filter((name) => /^\d{6}\.json$/.test(name))
    .map((name) => {
      const code = name.slice(0, 6);
      const exchange = inferExchange(code);
      return exchange ? `${code}.${exchange}` : "";
    })
    .filter(Boolean);
}

export function readTdxBars(tdxKlineDir, symbolOrCode) {
  const parsed = parseSymbol(symbolOrCode);
  if (!parsed) return [];
  const filePath = path.join(tdxKlineDir, `${parsed.code}.json`);
  const payload = readJson(filePath, null);
  if (!payload?.bars || !Array.isArray(payload.bars)) return [];
  return payload.bars
    .map((bar) => ({
      date: bar.date,
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number(bar.volume || 0),
      amount: Number(bar.amount || 0)
    }))
    .filter((bar) => bar.date && Number.isFinite(bar.open) && Number.isFinite(bar.close))
    .sort((left, right) => left.date.localeCompare(right.date));
}

export async function buildDictionary(
  db,
  { tdxKlineDir, hydrateNames = false, limit = 0, fuyaoAuthToken = "", fuyaoProjectId = "" } = {}
) {
  const aliases = loadAliasConfig();
  let inserted = 0;

  for (const alias of aliases) {
    const parsed = parseSymbol(alias.symbol || alias.code || "");
    if (!parsed) continue;
    upsertStock(db, {
      symbol: parsed.symbol,
      code: parsed.code,
      exchange: parsed.exchange,
      name: alias.name || "",
      aliases: alias.aliases || [],
      source: "config_alias"
    });
    inserted += 1;
  }

  for (const alias of aliases.filter((item) => !item.symbol && item.name)) {
    const candidates = await lookupCodes(alias.name).catch(() => []);
    const first = candidates[0];
    if (!first) continue;
    upsertStock(db, {
      symbol: first.symbol,
      code: first.code,
      exchange: first.exchange,
      name: alias.name,
      aliases: alias.aliases || [alias.name],
      source: "tonghuashun_code_lookup"
    });
    inserted += 1;
  }

  const symbols = listTdxSymbols(tdxKlineDir);
  const capped = limit > 0 ? symbols.slice(0, limit) : symbols;
  const existing = new Set(
    db.prepare("SELECT symbol FROM stock_dictionary").all().map((row) => row.symbol)
  );

  for (const symbol of capped) {
    if (existing.has(symbol)) continue;
    const parsed = parseSymbol(symbol);
    if (!parsed) continue;
    upsertStock(db, {
      symbol: parsed.symbol,
      code: parsed.code,
      exchange: parsed.exchange,
      name: "",
      aliases: [parsed.code, parsed.symbol],
      source: "tdx_code"
    });
    inserted += 1;
  }

  let hydrated = 0;
  if (hydrateNames) {
    const rows = db
      .prepare(
        "SELECT symbol FROM stock_dictionary WHERE name IS NULL OR name='' ORDER BY symbol"
      )
      .all();
    const target = limit > 0 ? rows.slice(0, limit) : rows;
    const snapshots = await fetchFuyaoSnapshots(target.map((row) => row.symbol), {
      authToken: fuyaoAuthToken,
      projectId: fuyaoProjectId
    });
    for (const snapshot of snapshots) {
      if (!snapshot.name) continue;
      upsertStock(db, {
        ...snapshot,
        aliases: [snapshot.name, snapshot.code, snapshot.symbol],
        source: "tonghuashun_fuyao_snapshot"
      });
      hydrated += 1;
    }
  }

  return {
    inserted,
    hydrated,
    total: db.prepare("SELECT COUNT(*) AS count FROM stock_dictionary").get().count
  };
}

export function getDictionaryStocks(db) {
  const rows = db
    .prepare("SELECT symbol, code, exchange, name, aliases_json FROM stock_dictionary")
    .all();
  return rows.map((row) => ({
    symbol: row.symbol || symbolFromCode(row.code),
    code: row.code,
    exchange: row.exchange,
    name: row.name || "",
    aliases: JSON.parse(row.aliases_json || "[]").filter(Boolean)
  }));
}

export function getDictionaryTerms(db) {
  const stocks = getDictionaryStocks(db);
  const terms = [];
  for (const stock of stocks) {
    const allTerms = new Set([stock.code, stock.symbol, stock.name, ...stock.aliases].filter(Boolean));
    for (const term of allTerms) {
      terms.push({
        term,
        normalized: String(term).toUpperCase(),
        stock: {
          symbol: stock.symbol,
          code: stock.code,
          exchange: stock.exchange,
          name: stock.name || stock.aliases[0] || stock.code
        }
      });
    }
  }
  return terms.sort((left, right) => right.term.length - left.term.length);
}
