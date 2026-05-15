import { chromium } from "playwright";
import {
  normalizeText,
  sleep,
  stableUserId,
  toDateStringFromUnixSeconds,
  toIsoFromUnixSeconds
} from "./common.mjs";
import { getIgnoredUserKeys, upsertAccount, upsertComment, upsertVideo } from "./db.mjs";

const DEFAULT_NAV_TIMEOUT_MS = 60000;

export class DouyinRiskControlError extends Error {
  constructor(message, { pauseKind = "verification", matchedPhrase = "" } = {}) {
    super(message);
    this.name = "DouyinRiskControlError";
    this.code = "DOUYIN_RISK_CONTROL";
    this.pauseKind = pauseKind;
    this.matchedPhrase = matchedPhrase;
  }
}

export function isDouyinRiskControlError(error) {
  return error?.code === "DOUYIN_RISK_CONTROL" || error?.name === "DouyinRiskControlError";
}

function debugCrawl(...args) {
  if (process.env.DEBUG_CRAWL) console.log("[crawl:debug]", ...args);
}

function isDouyinOkPayload(payload) {
  return (
    payload &&
    (payload.status_code === 0 ||
      Array.isArray(payload.aweme_list) ||
      Array.isArray(payload.comments))
  );
}

function isDouyinPostUrl(url, account) {
  return url.includes("/aweme/v1/web/aweme/post/") && url.includes(account.sec_user_id);
}

function isCommentUrl(url) {
  return (
    url.includes("/aweme/v1/web/comment/list/?") ||
    url.includes("/aweme/v1/web/comment/list/reply/?")
  );
}

function getUrlParam(url, name) {
  try {
    return new URL(url).searchParams.get(name) || "";
  } catch {
    return "";
  }
}

function withUrlParams(url, params) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value == null) next.searchParams.delete(key);
    else next.searchParams.set(key, String(value));
  }
  return next.toString();
}

function buildCommentListUrl({ awemeId, cursor = 0, count = 50 }) {
  const url = new URL("https://www.douyin.com/aweme/v1/web/comment/list/");
  url.searchParams.set("device_platform", "webapp");
  url.searchParams.set("aid", "6383");
  url.searchParams.set("channel", "channel_pc_web");
  url.searchParams.set("aweme_id", String(awemeId));
  url.searchParams.set("cursor", String(cursor));
  url.searchParams.set("count", String(count));
  url.searchParams.set("item_type", "0");
  return url.toString();
}

function normalizeVideo(video) {
  return {
    ...video,
    aweme_id: String(video.aweme_id || ""),
    desc: normalizeText(video.desc || ""),
    create_time: Number(video.create_time || 0) || null,
    create_date: toDateStringFromUnixSeconds(video.create_time)
  };
}

function normalizeComment(raw, { accountId, awemeId, parentCid = null }) {
  const user = raw.user || {};
  return {
    cid: String(raw.cid || ""),
    account_id: accountId,
    aweme_id: String(awemeId || ""),
    parent_cid: parentCid,
    root_cid: parentCid || String(raw.cid || ""),
    text: normalizeText(raw.text || ""),
    create_time: Number(raw.create_time || 0) || null,
    create_date: toDateStringFromUnixSeconds(raw.create_time),
    digg_count: Number(raw.digg_count || 0) || 0,
    reply_comment_total: Number(raw.reply_comment_total || 0) || 0,
    user_uid: String(user.uid || ""),
    user_sec_uid: String(user.sec_uid || ""),
    user_unique_id: String(user.unique_id || ""),
    user_short_id: String(user.short_id || ""),
    user_nickname: normalizeText(user.nickname || ""),
    raw
  };
}

async function parseJsonResponse(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchJsonInPage(page, url, timeoutMs = 30000) {
  const result = await page.evaluate(
    async ({ requestUrl, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(requestUrl, {
          credentials: "include",
          signal: controller.signal
        });
        const text = await response.text();
        try {
          return {
            ok: response.ok,
            status: response.status,
            json: JSON.parse(text)
          };
        } catch {
          return {
            ok: response.ok,
            status: response.status,
            text: text.slice(0, 300)
          };
        }
      } finally {
        clearTimeout(timer);
      }
    },
    { requestUrl: url, timeout: timeoutMs }
  );

  if (!result.ok || !result.json) {
    throw new Error(`Douyin API request failed: ${result.status} ${result.text || ""}`.trim());
  }
  if (!isDouyinOkPayload(result.json)) {
    throw new Error(
      `Douyin API returned status_code=${result.json.status_code}: ${
        result.json.status_msg || result.json.prompts || ""
      }`.trim()
    );
  }
  return result.json;
}

export async function launchDouyinContext({ profileDir, headless = true }) {
  const proxyServer = process.env.DOUYIN_BROWSER_PROXY_SERVER || "";
  const launchOptions = {
    headless: Boolean(headless),
    viewport: { width: 1365, height: 900 },
    locale: "zh-CN"
  };
  if (proxyServer && !/^(direct|none)$/iu.test(proxyServer)) {
    launchOptions.proxy = { server: proxyServer };
  }

  const context = await chromium.launchPersistentContext(profileDir, launchOptions);
  context.setDefaultTimeout(30000);
  context.setDefaultNavigationTimeout(DEFAULT_NAV_TIMEOUT_MS);
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(DEFAULT_NAV_TIMEOUT_MS);
  return { context, page };
}

async function assertNotLoginBlocked(page) {
  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 5000 })
    .catch(() => "");
  if (bodyText.includes("扫码登录") && bodyText.includes("登录即代表同意")) {
    throw new Error("Douyin login is required. Refresh the Playwright profile login state first.");
  }
  const verificationPhrases = [
    "安全验证",
    "请完成验证",
    "人机验证",
    "拖动滑块",
    "验证一下"
  ];
  const rateLimitPhrases = [
    "访问太频繁",
    "操作太频繁",
    "环境异常",
    "当前环境存在风险"
  ];
  const verificationPhrase = verificationPhrases.find((phrase) => bodyText.includes(phrase));
  if (verificationPhrase) {
    throw new DouyinRiskControlError("Douyin verification is required. Pause automated crawling.", {
      pauseKind: "verification",
      matchedPhrase: verificationPhrase
    });
  }
  const rateLimitPhrase = rateLimitPhrases.find((phrase) => bodyText.includes(phrase));
  if (rateLimitPhrase) {
    throw new DouyinRiskControlError("Douyin comment access looks rate-limited. Pause for cooldown.", {
      pauseKind: "rate_limit",
      matchedPhrase: rateLimitPhrase
    });
  }
}

function createStats() {
  return {
    videosSeen: 0,
    videosNew: 0,
    videosFailed: 0,
    topCommentsSeen: 0,
    replyCommentsSeen: 0,
    commentsNew: 0
  };
}

function saveVideosFromPayload(db, account, payload, stats, knownVideos) {
  let kept = 0;
  let pageMaxDate = "";
  const crawlSinceDate = account.crawl_since_date || account.since_date;
  for (const rawVideo of payload.aweme_list || []) {
    const video = normalizeVideo(rawVideo);
    if (!video.aweme_id) continue;
    if (video.create_date && (!pageMaxDate || video.create_date > pageMaxDate)) {
      pageMaxDate = video.create_date;
    }
    if (video.create_date && video.create_date < crawlSinceDate) continue;
    kept += 1;
    stats.videosSeen += 1;
    if (!knownVideos.has(video.aweme_id)) {
      stats.videosNew += 1;
      knownVideos.add(video.aweme_id);
    }
    upsertVideo(db, account.account_id, video);
  }
  return { kept, pageMaxDate };
}

async function captureProfilePostSeed(page, account) {
  let seed = null;
  const responseHandler = async (response) => {
    const url = response.url();
    if (seed || !isDouyinPostUrl(url, account)) return;
    const payload = await parseJsonResponse(response);
    if (!isDouyinOkPayload(payload)) return;
    seed = { url, payload };
  };

  page.on("response", responseHandler);
  try {
    console.log(`[crawl] open profile ${account.account_id}: ${account.display_name}`);
    await page.goto(account.profile_url, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_NAV_TIMEOUT_MS
    });
    await sleep(3000);
    await assertNotLoginBlocked(page);
    for (let index = 0; index < 12 && !seed; index += 1) {
      await page.mouse.wheel(0, 1400).catch(() => {});
      await sleep(1200);
    }
    if (!seed) throw new Error("No Douyin aweme/post response was captured.");
    return seed;
  } finally {
    page.off("response", responseHandler);
  }
}

async function crawlProfileVideosViaApi(db, page, account, options, stats, knownVideos) {
  const seed = await captureProfilePostSeed(page, account);
  let payload = seed.payload;
  let cursor = payload.max_cursor || 0;
  const pageSize = options.profilePageSize ?? 18;
  const maxPages = options.maxProfilePages ?? 0;
  let pageIndex = 0;

  while (payload) {
    const crawlSinceDate = account.crawl_since_date || account.since_date;
    const { pageMaxDate } = saveVideosFromPayload(db, account, payload, stats, knownVideos);
    if (!Number(payload.has_more)) break;
    if (pageIndex > 0 && pageMaxDate && pageMaxDate < crawlSinceDate) break;
    if (maxPages > 0 && pageIndex + 1 >= maxPages) break;

    const nextUrl = withUrlParams(seed.url, {
      max_cursor: cursor,
      count: pageSize
    });
    await sleep(options.apiDelayMs ?? 250);
    payload = await fetchJsonInPage(page, nextUrl, options.apiTimeoutMs ?? 30000);
    const nextCursor = payload.max_cursor || 0;
    if (nextCursor && String(nextCursor) === String(cursor)) break;
    cursor = nextCursor;
    pageIndex += 1;
  }
}

async function crawlProfileVideosByScroll(db, page, account, options, stats, knownVideos) {
  let postResponsesSeen = 0;
  const responseHandler = async (response) => {
    const url = response.url();
    if (!isDouyinPostUrl(url, account)) return;
    const payload = await parseJsonResponse(response);
    if (!isDouyinOkPayload(payload)) return;
    postResponsesSeen += 1;
    saveVideosFromPayload(db, account, payload, stats, knownVideos);
  };

  page.on("response", responseHandler);
  try {
    console.log(`[crawl] open profile ${account.account_id}: ${account.display_name}`);
    await page.goto(account.profile_url, { waitUntil: "domcontentloaded", timeout: DEFAULT_NAV_TIMEOUT_MS });
    await sleep(5000);
    await assertNotLoginBlocked(page);

    let lastCount = knownVideos.size;
    let lastResponseCount = postResponsesSeen;
    let idleLoops = 0;
    const maxScrolls = options.maxProfileScrolls ?? 160;
    for (let index = 0; maxScrolls <= 0 || index < maxScrolls; index += 1) {
      await page.mouse.wheel(0, 1800).catch(() => {});
      await sleep(1800);
      const currentCount = knownVideos.size;
      const currentResponseCount = postResponsesSeen;
      if (currentCount === lastCount && currentResponseCount === lastResponseCount) {
        idleLoops += 1;
      } else {
        idleLoops = 0;
        lastCount = currentCount;
        lastResponseCount = currentResponseCount;
      }
      if (idleLoops >= 8) break;
    }
  } finally {
    page.off("response", responseHandler);
  }
}

export async function crawlAccounts(db, accounts, options) {
  const { context, page } = await launchDouyinContext({
    profileDir: options.profileDir,
    headless: options.headless
  });

  try {
    const results = [];
    for (const account of accounts) {
      results.push(await crawlAccount(db, page, account, options));
    }
    return results;
  } finally {
    await context.close().catch(() => {});
  }
}

export async function crawlAccount(db, page, account, options = {}) {
  upsertAccount(db, account);
  const crawlSinceDate = account.crawl_since_date || account.since_date;
  const stats = createStats();
  const knownVideos = new Set(
    db
      .prepare("SELECT aweme_id FROM videos WHERE account_id = ?")
      .all(account.account_id)
      .map((row) => row.aweme_id)
  );

  if (options.apiMode !== false) {
    try {
      await crawlProfileVideosViaApi(db, page, account, options, stats, knownVideos);
    } catch (error) {
      console.warn(`[crawl] profile API pagination failed, falling back to scroll: ${error.message}`);
      await crawlProfileVideosByScroll(db, page, account, options, stats, knownVideos);
    }
  } else {
    await crawlProfileVideosByScroll(db, page, account, options, stats, knownVideos);
  }

  const videos = db
    .prepare(
      `
      SELECT aweme_id, desc, create_date, comment_count
      FROM videos
      WHERE account_id = ?
        AND create_date >= ?
      ORDER BY create_time DESC
    `
    )
    .all(account.account_id, crawlSinceDate);
  const selectedVideos = options.maxVideos > 0 ? videos.slice(0, options.maxVideos) : videos;

  if (!options.skipComments) {
    const commentOptions = {
      ...options,
      ignoredUsers: getIgnoredUserKeys(db)
    };
    for (const video of selectedVideos) {
      const videoPage = await page.context().newPage();
      videoPage.setDefaultTimeout(30000);
      videoPage.setDefaultNavigationTimeout(DEFAULT_NAV_TIMEOUT_MS);
      let timeout = null;
      try {
        const timeoutMs = options.videoTimeoutMs ?? 180000;
        await Promise.race([
          crawlVideoComments(db, videoPage, account, video, commentOptions, stats),
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              videoPage.close().catch(() => {});
              reject(new Error(`timed out after ${timeoutMs}ms`));
            }, timeoutMs);
          })
        ]);
      } catch (error) {
        if (isDouyinRiskControlError(error)) throw error;
        stats.videosFailed += 1;
        console.warn(`[crawl] video ${video.aweme_id} skipped: ${error.message}`);
      } finally {
        if (timeout) clearTimeout(timeout);
        await videoPage.close().catch(() => {});
      }
    }
  }

  return {
    account_id: account.account_id,
    videos_targeted: selectedVideos.length,
    ...stats
  };
}

function saveCommentsFromPayload(
  db,
  account,
  video,
  payload,
  { parentCid = null, knownComments, ignoredUsers = null, stats }
) {
  const saved = [];
  for (const rawComment of payload.comments || []) {
    const comment = normalizeComment(rawComment, {
      accountId: account.account_id,
      awemeId: video.aweme_id,
      parentCid
    });
    if (!comment.cid || !comment.text) continue;
    if (ignoredUsers?.has(`${comment.account_id}\t${stableUserId(comment)}`)) continue;
    if (parentCid) stats.replyCommentsSeen += 1;
    else stats.topCommentsSeen += 1;
    if (!knownComments.has(comment.cid)) {
      stats.commentsNew += 1;
      knownComments.add(comment.cid);
    }
    upsertComment(db, comment);
    saved.push(comment);
  }
  return saved;
}

async function captureCommentApiSeeds(page, video, options) {
  let commentSeed = null;
  let replySeed = null;
  const responseHandler = async (response) => {
    const url = response.url();
    if (!isCommentUrl(url)) return;
    const isReply = url.includes("/comment/list/reply/");
    const awemeId = getUrlParam(url, isReply ? "item_id" : "aweme_id");
    if (String(awemeId) !== String(video.aweme_id)) return;
    const payload = await parseJsonResponse(response);
    if (isReply) {
      if (!replySeed) replySeed = { url, payload };
      return;
    }
    if (!isDouyinOkPayload(payload)) return;
    if (!isReply && !commentSeed) commentSeed = { url, payload };
  };

  page.on("response", responseHandler);
  try {
    console.log(`[crawl] video ${video.aweme_id}: ${video.desc?.slice(0, 40) || ""}`);
    await page.goto(`https://www.douyin.com/video/${video.aweme_id}`, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_NAV_TIMEOUT_MS
    });
    await sleep(3000);
    await assertNotLoginBlocked(page);
    if (!commentSeed) {
      const url = buildCommentListUrl({
        awemeId: video.aweme_id,
        cursor: 0,
        count: options.commentPageSize ?? 50
      });
      commentSeed = {
        url,
        payload: await fetchJsonInPage(page, url, options.apiTimeoutMs ?? 30000)
      };
    }
    if (!options.noReplies) {
      replySeed = replySeed || (await captureReplySeedByClick(page, video));
    }
    return { commentSeed, replySeed };
  } finally {
    page.off("response", responseHandler);
  }
}

async function captureReplySeedByClick(page, video) {
  for (let index = 0; index < 4; index += 1) {
    await page.mouse.wheel(0, 1200).catch(() => {});
    await sleep(800);
  }
  for (let index = 0; index < 10; index += 1) {
    const candidate = page.locator("text=/展开\\d+条回复|展开更多回复|查看更多回复/").first();
    const visible = await candidate.isVisible().catch(() => false);
    debugCrawl("reply seed attempt", index, "visible", visible);
    if (visible) {
      debugCrawl("reply seed text", await candidate.innerText().catch(() => ""));
      const responsePromise = page
        .waitForResponse(
          (response) =>
            response.url().includes("/aweme/v1/web/comment/list/reply/") &&
            response.url().includes(String(video.aweme_id)),
          { timeout: 7000 }
        )
        .catch(() => null);
      const didClick = await candidate
        .click({ timeout: 5000 })
        .then(() => true)
        .catch(() => candidate.evaluate((node) => node.click()).then(() => true).catch(() => false));
      debugCrawl("reply seed clicked", didClick);
      if (didClick) {
        const response = await responsePromise;
        const payload = response ? await parseJsonResponse(response) : null;
        debugCrawl(
          "reply seed response",
          Boolean(response),
          payload?.status_code,
          payload ? Object.keys(payload).slice(0, 8) : [],
          response?.url().slice(0, 120)
        );
        if (response) {
          return { url: response.url(), payload };
        }
      }
    }
    await page.mouse.wheel(0, 1200).catch(() => {});
    await sleep(900);
  }
  return null;
}

async function crawlReplyCommentsViaApi(
  db,
  page,
  account,
  video,
  parentComment,
  replyTemplateUrl,
  replyPageSize,
  options,
  state
) {
  let cursor = 0;
  let lastCursor = null;
  const pageSize = replyPageSize || options.replyPageSize || 3;
  const maxPages = options.maxReplyPages ?? 0;
  let pageIndex = 0;

  while (true) {
    const url = withUrlParams(replyTemplateUrl, {
      item_id: video.aweme_id,
      comment_id: parentComment.cid,
      cursor,
      count: pageSize
    });
    await sleep(options.apiDelayMs ?? 250);
    const payload = await fetchJsonInPage(page, url, options.apiTimeoutMs ?? 30000);
    saveCommentsFromPayload(db, account, video, payload, {
      parentCid: parentComment.cid,
      knownComments: state.knownComments,
      ignoredUsers: state.ignoredUsers,
      stats: state.stats
    });

    const nextCursor = payload.cursor ?? 0;
    if (!Number(payload.has_more)) break;
    if (maxPages > 0 && pageIndex + 1 >= maxPages) break;
    if (String(nextCursor) === String(lastCursor)) break;
    lastCursor = cursor;
    cursor = nextCursor;
    pageIndex += 1;
  }
}

async function crawlVideoCommentsViaApi(db, page, account, video, options, stats, knownComments) {
  const { commentSeed, replySeed } = await captureCommentApiSeeds(page, video, options);
  const replyParents = new Map();
  const state = { knownComments, ignoredUsers: options.ignoredUsers, stats };

  let payload = commentSeed.payload;
  let cursor = payload.cursor ?? 0;
  let lastCursor = null;
  const pageSize = options.commentPageSize ?? 50;
  const maxPages = options.maxCommentPages ?? 0;
  let pageIndex = 0;

  while (payload) {
    const comments = saveCommentsFromPayload(db, account, video, payload, {
      knownComments,
      ignoredUsers: options.ignoredUsers,
      stats
    });
    for (const comment of comments) {
      if (comment.reply_comment_total > 0) replyParents.set(comment.cid, comment);
    }

    const nextCursor = payload.cursor ?? 0;
    if (!Number(payload.has_more)) break;
    if (maxPages > 0 && pageIndex + 1 >= maxPages) break;
    if (String(nextCursor) === String(lastCursor)) break;

    const nextUrl = withUrlParams(commentSeed.url, {
      cursor,
      count: pageSize
    });
    await sleep(options.apiDelayMs ?? 250);
    payload = await fetchJsonInPage(page, nextUrl, options.apiTimeoutMs ?? 30000);
    lastCursor = cursor;
    cursor = payload.cursor ?? 0;
    pageIndex += 1;
  }

  if (options.noReplies || replyParents.size === 0) return;

  if (!replySeed?.url) {
    console.warn(`[crawl] no reply/list template captured for ${video.aweme_id}; top comments saved, replies skipped`);
    return;
  }
  const replyTemplateUrl = replySeed.url;
  const replyTemplatePageSize = Number(new URL(replyTemplateUrl).searchParams.get("count")) || 3;

  for (const parentComment of replyParents.values()) {
    try {
      await crawlReplyCommentsViaApi(
        db,
        page,
        account,
        video,
        parentComment,
        replyTemplateUrl,
        replyTemplatePageSize,
        options,
        state
      );
    } catch (error) {
      console.warn(`[crawl] reply API failed for ${parentComment.cid}: ${error.message}`);
    }
  }
}

export async function crawlVideoComments(db, page, account, video, options = {}, stats = createStats()) {
  const knownComments = new Set(
    db
      .prepare("SELECT cid FROM comments WHERE aweme_id = ?")
      .all(video.aweme_id)
      .map((row) => row.cid)
  );

  if (options.apiMode !== false) {
    try {
      await crawlVideoCommentsViaApi(db, page, account, video, options, stats, knownComments);
      return;
    } catch (error) {
      if (isDouyinRiskControlError(error)) throw error;
      console.warn(`[crawl] comment API pagination failed, falling back to scroll: ${error.message}`);
    }
  }

  await crawlVideoCommentsByScroll(db, page, account, video, options, stats, knownComments);
}

async function crawlVideoCommentsByScroll(
  db,
  page,
  account,
  video,
  options = {},
  stats = createStats(),
  knownComments = null
) {
  knownComments =
    knownComments ||
    new Set(
      db
        .prepare("SELECT cid FROM comments WHERE aweme_id = ?")
        .all(video.aweme_id)
        .map((row) => row.cid)
    );
  let commentResponsesSeen = 0;

  const responseHandler = async (response) => {
    const url = response.url();
    if (!isCommentUrl(url)) return;
    const payload = await parseJsonResponse(response);
    if (!isDouyinOkPayload(payload)) return;
    commentResponsesSeen += 1;

    const isReply = url.includes("/comment/list/reply/");
    const awemeId = getUrlParam(url, isReply ? "item_id" : "aweme_id") || video.aweme_id;
    if (String(awemeId) !== String(video.aweme_id)) return;
    const parentCid = isReply ? getUrlParam(url, "comment_id") : null;

    for (const rawComment of payload.comments || []) {
      const comment = normalizeComment(rawComment, {
        accountId: account.account_id,
        awemeId,
        parentCid
      });
      if (!comment.cid || !comment.text) continue;
      if (options.ignoredUsers?.has(`${comment.account_id}\t${stableUserId(comment)}`)) continue;
      if (isReply) stats.replyCommentsSeen += 1;
      else stats.topCommentsSeen += 1;
      if (!knownComments.has(comment.cid)) {
        stats.commentsNew += 1;
        knownComments.add(comment.cid);
      }
      upsertComment(db, comment);
    }
  };

  page.on("response", responseHandler);
  try {
    console.log(`[crawl] video ${video.aweme_id}: ${video.desc?.slice(0, 40) || ""}`);
    await page.goto(`https://www.douyin.com/video/${video.aweme_id}`, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_NAV_TIMEOUT_MS
    });
    await sleep(5000);
    await assertNotLoginBlocked(page);

    let lastCount = knownComments.size;
    let lastResponseCount = commentResponsesSeen;
    let idleLoops = 0;
    const maxScrolls = options.maxCommentScrolls ?? 0;
    for (let index = 0; maxScrolls <= 0 || index < maxScrolls; index += 1) {
      if (!options.noReplies) {
        await clickVisibleReplyExpansions(page, options.maxReplyClicksPerLoop ?? 8);
      }
      await page.mouse.wheel(0, 1600).catch(() => {});
      await sleep(1600);
      const currentCount = knownComments.size;
      const currentResponseCount = commentResponsesSeen;
      if (currentCount === lastCount && currentResponseCount === lastResponseCount) {
        idleLoops += 1;
      } else {
        idleLoops = 0;
        lastCount = currentCount;
        lastResponseCount = currentResponseCount;
      }
      if (idleLoops >= 12) break;
    }
  } finally {
    page.off("response", responseHandler);
  }
}

async function clickVisibleReplyExpansions(page, limit) {
  const candidates = await page
    .locator("text=/展开\\d+条回复|展开更多回复|查看更多回复/")
    .all()
    .catch(() => []);
  let clicked = 0;
  for (const candidate of candidates) {
    if (clicked >= limit) break;
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    const didClick = await candidate
      .click({ timeout: 5000 })
      .then(() => true)
      .catch(() => candidate.evaluate((node) => node.click()).then(() => true).catch(() => false));
    if (!didClick) continue;
    clicked += 1;
    await sleep(250);
  }
  return clicked;
}

export function summarizeCrawlResults(results) {
  return results.reduce(
    (acc, item) => {
      acc.accounts += 1;
      acc.videos_targeted += item.videos_targeted || 0;
      acc.videos_seen += item.videosSeen || 0;
      acc.videos_new += item.videosNew || 0;
      acc.videos_failed += item.videosFailed || 0;
      acc.top_comments_seen += item.topCommentsSeen || 0;
      acc.reply_comments_seen += item.replyCommentsSeen || 0;
      acc.comments_new += item.commentsNew || 0;
      return acc;
    },
    {
      accounts: 0,
      videos_targeted: 0,
      videos_seen: 0,
      videos_new: 0,
      videos_failed: 0,
      top_comments_seen: 0,
      reply_comments_seen: 0,
      comments_new: 0,
      captured_at: toIsoFromUnixSeconds(Math.floor(Date.now() / 1000))
    }
  );
}
