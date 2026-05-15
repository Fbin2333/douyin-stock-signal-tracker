import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, nowIso, writeJson } from "./common.mjs";

export const ADAPTIVE_STATE_PATH = path.join(PROJECT_ROOT, "data/monitor-adaptive.json");

export const MONITOR_PROFILES = [
  {
    name: "normal",
    description: "low-frequency scheduled monitor",
    env: {
      MONITOR_SINCE_DAYS: "3",
      MONITOR_MAX_VIDEOS: "2",
      MONITOR_MAX_PROFILE_PAGES: "2",
      MONITOR_MAX_COMMENT_PAGES: "3",
      MONITOR_MAX_PROFILE_SCROLLS: "16",
      MONITOR_MAX_COMMENT_SCROLLS: "4",
      MONITOR_VIDEO_TIMEOUT_MS: "60000",
      MONITOR_RUN_TIMEOUT_SECONDS: "1200",
      MONITOR_ABBREVIATION_LIMIT: "80"
    }
  },
  {
    name: "cautious",
    description: "single-video cooldown probe with reduced pagination",
    env: {
      MONITOR_SINCE_DAYS: "2",
      MONITOR_MAX_VIDEOS: "1",
      MONITOR_MAX_PROFILE_PAGES: "1",
      MONITOR_MAX_COMMENT_PAGES: "2",
      MONITOR_MAX_PROFILE_SCROLLS: "8",
      MONITOR_MAX_COMMENT_SCROLLS: "2",
      MONITOR_VIDEO_TIMEOUT_MS: "45000",
      MONITOR_RUN_TIMEOUT_SECONDS: "900",
      MONITOR_ABBREVIATION_LIMIT: "20"
    }
  },
  {
    name: "minimum",
    description: "minimum one-video one-page comment probe",
    env: {
      MONITOR_SINCE_DAYS: "1",
      MONITOR_MAX_VIDEOS: "1",
      MONITOR_MAX_PROFILE_PAGES: "1",
      MONITOR_MAX_COMMENT_PAGES: "1",
      MONITOR_MAX_PROFILE_SCROLLS: "4",
      MONITOR_MAX_COMMENT_SCROLLS: "1",
      MONITOR_VIDEO_TIMEOUT_MS: "30000",
      MONITOR_RUN_TIMEOUT_SECONDS: "600",
      MONITOR_ABBREVIATION_LIMIT: "0"
    }
  }
];

export function profileByName(name) {
  return MONITOR_PROFILES.find((profile) => profile.name === name) || MONITOR_PROFILES[0];
}

export function nextProfileName(name) {
  const index = MONITOR_PROFILES.findIndex((profile) => profile.name === name);
  const currentIndex = index >= 0 ? index : 0;
  return MONITOR_PROFILES[Math.min(currentIndex + 1, MONITOR_PROFILES.length - 1)].name;
}

export function defaultAdaptiveState() {
  return {
    updated_at: nowIso(),
    current_profile: "normal",
    status: "ready",
    last_rate_limit: null,
    last_success: null
  };
}

export function readAdaptiveState(filePath = ADAPTIVE_STATE_PATH) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return defaultAdaptiveState();
  }
}

export function writeAdaptiveState(state, filePath = ADAPTIVE_STATE_PATH) {
  writeJson(filePath, state);
  return state;
}

export function buildProfileEnv(state = defaultAdaptiveState()) {
  const profile = profileByName(state.current_profile);
  return {
    MONITOR_ADAPTIVE_PROFILE: profile.name,
    ...profile.env
  };
}

export function shellExports(env) {
  return Object.entries(env)
    .map(([key, value]) => `export ${key}='${String(value).replaceAll("'", "'\\''")}'`)
    .join("\n");
}

export function recordRateLimit(state, { account = "all", slot = "manual", detail = "" } = {}) {
  const previousProfile = profileByName(state.current_profile).name;
  const nextProfile = nextProfileName(previousProfile);
  return {
    ...state,
    updated_at: nowIso(),
    current_profile: nextProfile,
    status: "cooldown",
    last_rate_limit: {
      account,
      slot,
      detail,
      previous_profile: previousProfile,
      next_profile: nextProfile,
      updated_at: nowIso()
    }
  };
}

export function summarizeCrawlForValidation(result) {
  const crawl = result?.crawl || {};
  const targeted = Number(crawl.videos_targeted || 0);
  const commentsSeen = Number(crawl.top_comments_seen || 0) + Number(crawl.reply_comments_seen || 0);
  return {
    targeted,
    commentsSeen,
    ok: targeted > 0 && commentsSeen > 0
  };
}

export function recordSuccess(state, { account = "all", slot = "manual", result = null } = {}) {
  const validation = summarizeCrawlForValidation(result);
  return {
    ...state,
    updated_at: nowIso(),
    status: validation.ok ? "validated" : "ran_without_validation",
    last_success: {
      account,
      slot,
      profile: profileByName(state.current_profile).name,
      validation,
      updated_at: nowIso()
    }
  };
}
