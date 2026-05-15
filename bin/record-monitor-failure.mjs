#!/usr/bin/env node

import path from "node:path";
import { PROJECT_ROOT, nowIso, writeJson } from "../src/lib/common.mjs";

const [reason = "monitor_failed", ...detailParts] = process.argv.slice(2);
const detail = detailParts.join(" ").trim();
const updatedAt = nowIso();

const failure = {
  reason,
  detail,
  updated_at: updatedAt
};

writeJson(path.join(PROJECT_ROOT, "data/latest-monitor-result.json"), {
  updated_at: updatedAt,
  ok: false,
  failure,
  alerts: {
    queued: 0,
    pending: 0,
    sent: 0,
    localOnly: 0,
    failed: 0
  }
});

writeJson(path.join(PROJECT_ROOT, "data/codex-review-queue.json"), {
  updated_at: updatedAt,
  review_required: true,
  reasons: [reason],
  summary: {
    failure,
    alerts: {
      queued: 0,
      pending_processed: 0,
      sent: 0,
      local_only: 0,
      failed: 0
    }
  },
  alert_previews: [],
  codex_next_step:
    "Monitor did not complete. Inspect data/monitor.err.log, data/monitor.out.log, and launchd process state before trusting reports/latest.md."
});
