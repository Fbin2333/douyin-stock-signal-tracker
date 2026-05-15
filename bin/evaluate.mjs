#!/usr/bin/env node

import { getDb } from "../src/lib/db.mjs";
import { getRuntimeConfig } from "../src/lib/config.mjs";
import { evaluateAll } from "../src/lib/evaluator.mjs";
import { boolArg, parseArgs } from "../src/lib/cli.mjs";

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getRuntimeConfig();
  const db = getDb();
  const result = evaluateAll(db, {
    tdxKlineDir: config.tdxKlineDir,
    extractMentions: boolArg(args, "extractMentions", true)
  });
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}
