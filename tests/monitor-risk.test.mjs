import assert from "node:assert/strict";
import test from "node:test";

import { DouyinRiskControlError } from "../src/lib/douyin-crawler.mjs";
import { detectRiskControl } from "../src/lib/monitor-risk.mjs";

test("explicit Douyin verification error pauses monitor", () => {
  const risk = detectRiskControl(null, new DouyinRiskControlError("Douyin verification is required."));
  assert.equal(risk.kind, "verification");
  assert.equal(risk.reason, "douyin_verification_required");
  assert.equal(risk.stateReason, "monitor_paused_for_douyin_verification");
  assert.equal(risk.requiresManualVerification, true);
});

test("explicit Douyin rate-limit text enters cooldown", () => {
  const risk = detectRiskControl(
    null,
    new DouyinRiskControlError("Douyin comment access looks rate-limited.", {
      pauseKind: "rate_limit",
      matchedPhrase: "访问太频繁"
    })
  );
  assert.equal(risk.kind, "rate_limit");
  assert.equal(risk.reason, "douyin_comment_rate_limited_suspected");
  assert.equal(risk.stateReason, "monitor_paused_for_douyin_rate_limit");
  assert.equal(risk.requiresManualVerification, false);
});

test("zero comment payload across targeted videos enters cooldown before alerting", () => {
  const risk = detectRiskControl({
    videos_targeted: 2,
    videos_failed: 1,
    top_comments_seen: 0,
    reply_comments_seen: 0
  });
  assert.equal(risk.kind, "rate_limit");
  assert.equal(risk.reason, "douyin_comment_rate_limited_suspected");
  assert.equal(risk.stateReason, "monitor_paused_for_douyin_rate_limit");
  assert.equal(risk.requiresManualVerification, false);
  assert.match(risk.detail, /videos_targeted=2/);
});

test("comments seen means normal monitor can continue", () => {
  const risk = detectRiskControl({
    videos_targeted: 2,
    videos_failed: 1,
    top_comments_seen: 8,
    reply_comments_seen: 0
  });
  assert.equal(risk, null);
});
