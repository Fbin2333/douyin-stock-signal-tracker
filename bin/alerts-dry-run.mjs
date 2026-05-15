#!/usr/bin/env node

import { getDb } from "../src/lib/db.mjs";
import { previewAlerts } from "../src/lib/alerts.mjs";

function main() {
  const db = getDb();
  const alerts = previewAlerts(db);
  if (alerts.length === 0) {
    console.log("No pending alert candidates.");
    return;
  }
  for (const alert of alerts) {
    console.log("=".repeat(72));
    console.log(`mention_id=${alert.mention_id} type=${alert.alert_type}`);
    console.log(alert.message);
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}
