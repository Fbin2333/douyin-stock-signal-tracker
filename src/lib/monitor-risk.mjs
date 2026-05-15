import { isDouyinRiskControlError } from "./douyin-crawler.mjs";

export function detectRiskControl(crawl, error = null) {
  if (isDouyinRiskControlError(error)) {
    if (error.pauseKind === "rate_limit") {
      return {
        kind: "rate_limit",
        reason: "douyin_comment_rate_limited_suspected",
        stateReason: "monitor_paused_for_douyin_rate_limit",
        requiresManualVerification: false,
        detail: error.message
      };
    }
    return {
      kind: "verification",
      reason: "douyin_verification_required",
      stateReason: "monitor_paused_for_douyin_verification",
      requiresManualVerification: true,
      detail: error.message
    };
  }

  const targeted = Number(crawl?.videos_targeted || 0);
  const failed = Number(crawl?.videos_failed || 0);
  const commentsSeen = Number(crawl?.top_comments_seen || 0) + Number(crawl?.reply_comments_seen || 0);
  if (targeted <= 0) return null;
  if (commentsSeen > 0) return null;

  if (targeted >= 2 || failed > 0) {
    return {
      kind: "rate_limit",
      reason: "douyin_comment_rate_limited_suspected",
      stateReason: "monitor_paused_for_douyin_rate_limit",
      requiresManualVerification: false,
      detail: `videos_targeted=${targeted} videos_failed=${failed} comments_seen=${commentsSeen}`
    };
  }

  return null;
}
