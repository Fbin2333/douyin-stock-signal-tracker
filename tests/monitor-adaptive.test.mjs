import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProfileEnv,
  defaultAdaptiveState,
  recordRateLimit,
  recordSuccess,
  summarizeCrawlForValidation
} from "../src/lib/monitor-adaptive.mjs";

test("rate limit moves adaptive monitor to a stricter profile", () => {
  const state = defaultAdaptiveState();
  const next = recordRateLimit(state, {
    account: "account_b",
    slot: "evening",
    detail: "comments_seen=0"
  });
  assert.equal(next.current_profile, "cautious");
  assert.equal(next.status, "cooldown");
  assert.equal(next.last_rate_limit.previous_profile, "normal");
  assert.equal(next.last_rate_limit.next_profile, "cautious");
});

test("adaptive profile env lowers crawl pressure", () => {
  const state = recordRateLimit(defaultAdaptiveState(), {});
  const env = buildProfileEnv(state);
  assert.equal(env.MONITOR_ADAPTIVE_PROFILE, "cautious");
  assert.equal(env.MONITOR_MAX_VIDEOS, "1");
  assert.equal(env.MONITOR_MAX_COMMENT_PAGES, "2");
});

test("validation requires comments to be seen in a targeted run", () => {
  assert.deepEqual(
    summarizeCrawlForValidation({
      crawl: { videos_targeted: 1, top_comments_seen: 3, reply_comments_seen: 0 }
    }),
    { targeted: 1, commentsSeen: 3, ok: true }
  );
  assert.deepEqual(
    summarizeCrawlForValidation({
      crawl: { videos_targeted: 1, top_comments_seen: 0, reply_comments_seen: 0 }
    }),
    { targeted: 1, commentsSeen: 0, ok: false }
  );
});

test("successful validated run records the working profile", () => {
  const cooled = recordRateLimit(defaultAdaptiveState(), {});
  const next = recordSuccess(cooled, {
    account: "account_a",
    slot: "noon_close",
    result: { crawl: { videos_targeted: 1, top_comments_seen: 2, reply_comments_seen: 0 } }
  });
  assert.equal(next.status, "validated");
  assert.equal(next.current_profile, "cautious");
  assert.equal(next.last_success.profile, "cautious");
  assert.equal(next.last_success.validation.ok, true);
});
