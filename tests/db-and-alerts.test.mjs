import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAbbreviationsForAllComments } from "../src/lib/abbreviation-resolver.mjs";
import { postFeishu, previewAlerts } from "../src/lib/alerts.mjs";
import {
  getDb,
  getIgnoredUserKeys,
  refreshUserStats,
  upsertAccount,
  upsertComment,
  upsertEvaluation,
  upsertMention,
  upsertStock,
  upsertVideo
} from "../src/lib/db.mjs";
import { extractMentionsForAllComments } from "../src/lib/mentions.mjs";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-stock-test-"));
  return getDb(path.join(dir, "test.db"));
}

function seedBase(db) {
  upsertAccount(db, {
    account_id: "account_a",
    display_name: "示例账号A",
    profile_url: "https://www.douyin.com/user/x",
    sec_user_id: "x",
    since_date: "2026-01-26",
    enabled: true
  });
  upsertVideo(db, "account_a", {
    aweme_id: "v1",
    desc: "测试视频",
    create_time: 1775000000,
    create_date: "2026-04-01",
    statistics: { comment_count: 1, digg_count: 1 }
  });
  upsertStock(db, {
    symbol: "002639.SZ",
    code: "002639",
    exchange: "SZ",
    name: "雪人集团",
    aliases: ["雪人集团"],
    source: "test"
  });
}

function seedSecondAccount(db) {
  upsertAccount(db, {
    account_id: "account_b",
    display_name: "示例账号B",
    profile_url: "https://www.douyin.com/user/y",
    sec_user_id: "y",
    since_date: "2025-01-04",
    enabled: true
  });
  upsertVideo(db, "account_b", {
    aweme_id: "v2",
    desc: "第二账号视频",
    create_time: 1775000100,
    create_date: "2026-04-01",
    statistics: { comment_count: 1, digg_count: 1 }
  });
}

function insertMentionWithEvaluation(
  db,
  { accountId, awemeId, cid, userSecUid, userNickname, status, isWin, returnPct }
) {
  const comment = {
    cid,
    account_id: accountId,
    aweme_id: awemeId,
    parent_cid: null,
    root_cid: cid,
    text: "雪人集团",
    create_time: 1775000000 + Number(String(cid).replace(/\D/g, "") || 0),
    create_date: "2026-04-01",
    digg_count: 1,
    reply_comment_total: 0,
    user_uid: "",
    user_sec_uid: userSecUid,
    user_unique_id: "",
    user_short_id: "",
    user_nickname: userNickname
  };
  upsertComment(db, comment);
  upsertMention(
    db,
    comment,
    { symbol: "002639.SZ", code: "002639", exchange: "SZ", name: "雪人集团" },
    "雪人集团"
  );
  const mention = db
    .prepare("SELECT id FROM stock_mentions WHERE comment_cid = ?")
    .get(cid);
  upsertEvaluation(db, {
    mention_id: mention.id,
    status,
    baseline_date: "2026-04-02",
    baseline_open: 10,
    window_start_date: "2026-04-02",
    window_end_date: "2026-04-08",
    max_close: status === "pending" ? null : 10 + returnPct / 10,
    max_close_date: status === "pending" ? null : "2026-04-03",
    max_close_return_pct: status === "pending" ? null : returnPct,
    is_win: status === "completed" ? isWin : null,
    window: []
  });
  return mention.id;
}

test("comment ingestion is idempotent by cid", () => {
  const db = tempDb();
  seedBase(db);
  const comment = {
    cid: "c1",
    account_id: "account_a",
    aweme_id: "v1",
    parent_cid: null,
    root_cid: "c1",
    text: "雪人集团",
    create_time: 1775185412,
    create_date: "2026-04-03",
    digg_count: 1,
    reply_comment_total: 0,
    user_uid: "u1",
    user_sec_uid: "su1",
    user_unique_id: "dy1",
    user_short_id: "1",
    user_nickname: "IT厨子"
  };
  upsertComment(db, comment);
  upsertComment(db, comment);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM comments").get().count, 1);
  db.close();
});

test("pending mention from high-win user produces alert preview", () => {
  const db = tempDb();
  seedBase(db);
  for (let index = 1; index <= 4; index += 1) {
    const comment = {
      cid: `c${index}`,
      account_id: "account_a",
      aweme_id: "v1",
      parent_cid: null,
      root_cid: `c${index}`,
      text: "雪人集团",
      create_time: 1775000000 + index,
      create_date: "2026-04-01",
      digg_count: 1,
      reply_comment_total: 0,
      user_uid: "u1",
      user_sec_uid: "su1",
      user_unique_id: "dy1",
      user_short_id: "1",
      user_nickname: "IT厨子"
    };
    upsertComment(db, comment);
    upsertMention(
      db,
      comment,
      { symbol: "002639.SZ", code: "002639", exchange: "SZ", name: "雪人集团" },
      "雪人集团"
    );
    upsertEvaluation(db, {
      mention_id: index,
      status: "completed",
      baseline_date: "2026-04-02",
      baseline_open: 10,
      window_start_date: "2026-04-02",
      window_end_date: "2026-04-08",
      max_close: 11,
      max_close_date: "2026-04-03",
      max_close_return_pct: 10,
      is_win: 1,
      window: []
    });
  }
  const newComment = {
    cid: "c5",
    account_id: "account_a",
    aweme_id: "v1",
    parent_cid: null,
    root_cid: "c5",
    text: "雪人集团",
    create_time: 1777000000,
    create_date: "2026-04-24",
    digg_count: 1,
    reply_comment_total: 0,
    user_uid: "u1",
    user_sec_uid: "su1",
    user_unique_id: "dy1",
    user_short_id: "1",
    user_nickname: "IT厨子"
  };
  upsertComment(db, newComment);
  upsertMention(
    db,
    newComment,
    { symbol: "002639.SZ", code: "002639", exchange: "SZ", name: "雪人集团" },
    "雪人集团"
  );
  upsertEvaluation(db, {
    mention_id: 5,
    status: "pending",
    baseline_date: "2026-04-27",
    baseline_open: 10,
    window_start_date: "2026-04-27",
    window_end_date: "2026-04-29",
    max_close: null,
    max_close_date: null,
    max_close_return_pct: null,
    is_win: null,
    window: []
  });
  refreshUserStats(db);
  const previews = previewAlerts(db);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].mention_id, 5);
  assert.match(previews[0].message, /高胜率用户/);
  assert.match(previews[0].message, /视频日期/);
  db.close();
});

test("low-win user above threshold is ignored for alerts", () => {
  const db = tempDb();
  seedBase(db);
  for (let index = 1; index <= 6; index += 1) {
    const comment = {
      cid: `low${index}`,
      account_id: "account_a",
      aweme_id: "v1",
      parent_cid: null,
      root_cid: `low${index}`,
      text: "雪人集团",
      create_time: 1775000000 + index,
      create_date: "2026-04-01",
      digg_count: 1,
      reply_comment_total: 0,
      user_uid: "u2",
      user_sec_uid: "su2",
      user_unique_id: "dy2",
      user_short_id: "2",
      user_nickname: "低胜率"
    };
    upsertComment(db, comment);
    upsertMention(
      db,
      comment,
      { symbol: "002639.SZ", code: "002639", exchange: "SZ", name: "雪人集团" },
      "雪人集团"
    );
    upsertEvaluation(db, {
      mention_id: index,
      status: "completed",
      baseline_date: "2026-04-02",
      baseline_open: 10,
      window_start_date: "2026-04-02",
      window_end_date: "2026-04-08",
      max_close: 9,
      max_close_date: "2026-04-03",
      max_close_return_pct: -10,
      is_win: 0,
      window: []
    });
  }
  refreshUserStats(db);
  const stats = db
    .prepare("SELECT tier FROM user_stats WHERE account_id='account_a' AND user_stable_id='su2'")
    .get();
  assert.equal(stats.tier, "ignored");
  assert.equal(previewAlerts(db).length, 0);
  db.close();
});

test("global user stats aggregate the same commenter across accounts for alerts", () => {
  const db = tempDb();
  seedBase(db);
  seedSecondAccount(db);

  for (const account of [
    { accountId: "account_a", awemeId: "v1" },
    { accountId: "account_b", awemeId: "v2" }
  ]) {
    for (let index = 1; index <= 2; index += 1) {
      insertMentionWithEvaluation(db, {
        ...account,
        cid: `${account.accountId}-win-${index}`,
        userSecUid: "same-user",
        userNickname: "跨账号高手",
        status: "completed",
        isWin: 1,
        returnPct: 5
      });
    }
  }
  const pendingId = insertMentionWithEvaluation(db, {
    accountId: "account_b",
    awemeId: "v2",
    cid: "account_b-pending-1",
    userSecUid: "same-user",
    userNickname: "跨账号高手",
    status: "pending",
    isWin: null,
    returnPct: null
  });

  refreshUserStats(db);

  const global = db
    .prepare("SELECT * FROM user_stats_global WHERE user_stable_id = ?")
    .get("same-user");
  assert.equal(global.account_count, 2);
  assert.equal(global.completed_mentions, 4);
  assert.equal(global.win_count, 4);
  assert.equal(global.win_rate, 1);
  assert.equal(global.tier, "elite");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM user_stats WHERE tier = 'elite'").get().count,
    0
  );

  const previews = previewAlerts(db);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].mention_id, pendingId);
  assert.equal(previews[0].alert_type, "global_elite");
  assert.match(previews[0].message, /跨账号：覆盖 2 个账号/);
  db.close();
});

test("global low-win users are ignored across all configured accounts", () => {
  const db = tempDb();
  seedBase(db);
  seedSecondAccount(db);
  upsertAccount(db, {
    account_id: "third",
    display_name: "第三账号",
    profile_url: "https://www.douyin.com/user/z",
    sec_user_id: "z",
    since_date: "2026-01-01",
    enabled: true
  });

  for (const account of [
    { accountId: "account_a", awemeId: "v1" },
    { accountId: "account_b", awemeId: "v2" }
  ]) {
    for (let index = 1; index <= 3; index += 1) {
      insertMentionWithEvaluation(db, {
        ...account,
        cid: `${account.accountId}-loss-${index}`,
        userSecUid: "global-low",
        userNickname: "跨账号低胜率",
        status: "completed",
        isWin: 0,
        returnPct: -5
      });
    }
  }

  refreshUserStats(db);

  const global = db
    .prepare("SELECT tier, completed_mentions, win_rate FROM user_stats_global WHERE user_stable_id = ?")
    .get("global-low");
  assert.equal(global.tier, "ignored");
  assert.equal(global.completed_mentions, 6);
  assert.equal(global.win_rate, 0);
  const ignoredKeys = getIgnoredUserKeys(db);
  assert.equal(ignoredKeys.has("account_a\tglobal-low"), true);
  assert.equal(ignoredKeys.has("account_b\tglobal-low"), true);
  assert.equal(ignoredKeys.has("third\tglobal-low"), true);
  db.close();
});

test("context filter removes previously extracted consultation mentions", () => {
  const db = tempDb();
  seedBase(db);
  const comment = {
    cid: "consult1",
    account_id: "account_a",
    aweme_id: "v1",
    parent_cid: null,
    root_cid: "consult1",
    text: "雪人集团能买吗？",
    create_time: 1775000000,
    create_date: "2026-04-01",
    digg_count: 1,
    reply_comment_total: 0,
    user_uid: "u3",
    user_sec_uid: "su3",
    user_unique_id: "dy3",
    user_short_id: "3",
    user_nickname: "咨询者"
  };
  upsertComment(db, comment);
  upsertMention(
    db,
    comment,
    { symbol: "002639.SZ", code: "002639", exchange: "SZ", name: "雪人集团" },
    "雪人集团"
  );

  const result = extractMentionsForAllComments(db);

  assert.equal(result.skippedContext, 1);
  assert.equal(result.deletedRejected, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM stock_mentions").get().count, 0);
  db.close();
});

test("abbreviation resolver creates signal mentions through agent verdict", async () => {
  const db = tempDb();
  seedBase(db);
  upsertStock(db, {
    symbol: "002342.SZ",
    code: "002342",
    exchange: "SZ",
    name: "巨力索具",
    aliases: ["巨力索具"],
    source: "test"
  });
  upsertComment(db, {
    cid: "abbr1",
    account_id: "account_a",
    aweme_id: "v1",
    parent_cid: null,
    root_cid: "abbr1",
    text: "巨力今天绝绝子",
    create_time: 1775000200,
    create_date: "2026-04-01",
    digg_count: 1,
    reply_comment_total: 0,
    user_uid: "",
    user_sec_uid: "abbr-user",
    user_unique_id: "",
    user_short_id: "",
    user_nickname: "缩写用户"
  });

  const result = await resolveAbbreviationsForAllComments(db, {
    signalAgent: { endpoint: "mock", apiKey: "mock", model: "mock" },
    agentResolver: async () => [
      {
        matched: true,
        symbol: "002342.SZ",
        name: "巨力索具",
        mentionText: "巨力",
        label: "signal",
        confidence: 0.9,
        reason: "mock"
      }
    ]
  });

  assert.equal(result.created, 1);
  const mention = db.prepare("SELECT * FROM stock_mentions WHERE comment_cid='abbr1'").get();
  assert.equal(mention.symbol, "002342.SZ");
  assert.equal(mention.mention_text, "巨力");
  db.close();
});

test("abbreviation resolver skips ambiguous same-token matches", async () => {
  const db = tempDb();
  seedBase(db);
  for (const stock of [
    {
      symbol: "603778.SH",
      code: "603778",
      exchange: "SH",
      name: "国晟科技"
    },
    {
      symbol: "605588.SH",
      code: "605588",
      exchange: "SH",
      name: "冠石科技"
    }
  ]) {
    upsertStock(db, { ...stock, aliases: [stock.name], source: "test" });
  }
  upsertComment(db, {
    cid: "abbr2",
    account_id: "account_a",
    aweme_id: "v1",
    parent_cid: null,
    root_cid: "abbr2",
    text: "gskj，明天后天逐步建仓",
    create_time: 1775000300,
    create_date: "2026-04-01",
    digg_count: 1,
    reply_comment_total: 0,
    user_uid: "",
    user_sec_uid: "abbr-user-2",
    user_unique_id: "",
    user_short_id: "",
    user_nickname: "缩写用户2"
  });

  const result = await resolveAbbreviationsForAllComments(db, {
    signalAgent: { endpoint: "mock", apiKey: "mock", model: "mock" },
    agentResolver: async () => [
      {
        matched: true,
        symbol: "603778.SH",
        name: "国晟科技",
        mentionText: "gskj",
        label: "signal",
        confidence: 0.95,
        reason: "mock"
      },
      {
        matched: true,
        symbol: "605588.SH",
        name: "冠石科技",
        mentionText: "gskj",
        label: "signal",
        confidence: 0.95,
        reason: "mock"
      }
    ]
  });

  assert.equal(result.created, 0);
  assert.equal(result.skippedAmbiguousCandidate, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM stock_mentions").get().count, 0);
  db.close();
});

test("Feishu webhook business errors are treated as send failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new globalThis.Response(JSON.stringify({ code: 19024, msg: "keyword not found" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  try {
    await assert.rejects(
      () => postFeishu("https://open.feishu.cn/open-apis/bot/v2/hook/test", "missing keyword"),
      /Feishu 19024: keyword not found/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
