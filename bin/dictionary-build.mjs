#!/usr/bin/env node

import { getDb } from "../src/lib/db.mjs";
import { getRuntimeConfig } from "../src/lib/config.mjs";
import { buildDictionary } from "../src/lib/stock-data.mjs";
import { boolArg, intArg, parseArgs } from "../src/lib/cli.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getRuntimeConfig();
  const db = getDb();
  const result = await buildDictionary(db, {
    tdxKlineDir: config.tdxKlineDir,
    hydrateNames: !boolArg(args, "skipNames", false),
    fuyaoAuthToken: config.tonghuashun.fuyaoAuthToken,
    fuyaoProjectId: config.tonghuashun.fuyaoProjectId,
    limit: intArg(args, "limit", 0)
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
