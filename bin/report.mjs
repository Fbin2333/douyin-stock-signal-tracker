#!/usr/bin/env node

import { getDb } from "../src/lib/db.mjs";
import { getRuntimeConfig } from "../src/lib/config.mjs";
import { generateReports } from "../src/lib/report.mjs";

function main() {
  const config = getRuntimeConfig();
  const db = getDb();
  const result = generateReports(db, { reportDir: config.reportDir });
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}
