#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  ADAPTIVE_STATE_PATH,
  buildProfileEnv,
  readAdaptiveState,
  recordRateLimit,
  recordSuccess,
  shellExports,
  writeAdaptiveState
} from "../src/lib/monitor-adaptive.mjs";
import { PROJECT_ROOT } from "../src/lib/common.mjs";

function readLatestResult() {
  const resultPath = path.join(PROJECT_ROOT, "data/latest-monitor-result.json");
  try {
    return JSON.parse(fs.readFileSync(resultPath, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const [command = "show", account = "all", slot = "manual", ...detailParts] = process.argv.slice(2);
  const state = readAdaptiveState();

  if (command === "env") {
    process.stdout.write(`${shellExports(buildProfileEnv(state))}\n`);
    return;
  }

  if (command === "rate-limit") {
    const detail = detailParts.join(" ").trim();
    const nextState = recordRateLimit(state, { account, slot, detail });
    writeAdaptiveState(nextState);
    console.log(JSON.stringify(nextState, null, 2));
    return;
  }

  if (command === "pause") {
    const result = readLatestResult();
    if (result?.failure?.reason === "monitor_paused_for_douyin_rate_limit") {
      const detail = result.failure.detail || detailParts.join(" ").trim();
      const nextState = recordRateLimit(state, { account, slot, detail });
      writeAdaptiveState(nextState);
      console.log(JSON.stringify(nextState, null, 2));
      return;
    }
    const nextState = {
      ...state,
      updated_at: new Date().toISOString(),
      status: result?.failure?.reason === "monitor_paused_for_douyin_verification" ? "verification_paused" : "paused"
    };
    writeAdaptiveState(nextState);
    console.log(JSON.stringify(nextState, null, 2));
    return;
  }

  if (command === "success") {
    const nextState = recordSuccess(state, { account, slot, result: readLatestResult() });
    writeAdaptiveState(nextState);
    console.log(JSON.stringify(nextState, null, 2));
    return;
  }

  if (command === "reset") {
    const nextState = {
      updated_at: new Date().toISOString(),
      current_profile: "normal",
      status: "ready",
      last_rate_limit: null,
      last_success: null
    };
    writeAdaptiveState(nextState);
    console.log(JSON.stringify(nextState, null, 2));
    return;
  }

  if (command === "path") {
    console.log(ADAPTIVE_STATE_PATH);
    return;
  }

  console.log(JSON.stringify(state, null, 2));
}

main();
