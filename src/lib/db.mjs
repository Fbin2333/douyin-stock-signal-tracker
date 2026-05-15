import Database from "better-sqlite3";
import path from "node:path";
import { ensureDir, nowIso, stableUserId } from "./common.mjs";
import { getRuntimeConfig } from "./config.mjs";

export const ALERT_MIN_COMPLETED_MENTIONS = 4;
export const ALERT_MIN_WIN_RATE = 0.75;
export const IGNORE_MIN_COMPLETED_MENTIONS = 6;
export const IGNORE_MAX_WIN_RATE = 0.5;

let activeDb = null;

export function getDb(dbPath = null) {
  if (activeDb && !dbPath) {
    return activeDb;
  }

  const resolved = path.resolve(dbPath || getRuntimeConfig().dbPath);
  ensureDir(path.dirname(resolved));
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);

  if (!dbPath) {
    activeDb = db;
  }
  return db;
}

export function closeDb() {
  if (activeDb) {
    activeDb.close();
    activeDb = null;
  }
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id    TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      profile_url   TEXT NOT NULL,
      sec_user_id   TEXT NOT NULL,
      since_date    TEXT NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      raw_json      TEXT,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS videos (
      aweme_id      TEXT PRIMARY KEY,
      account_id    TEXT NOT NULL,
      desc          TEXT,
      create_time   INTEGER,
      create_date   TEXT,
      comment_count INTEGER,
      digg_count    INTEGER,
      share_url     TEXT,
      raw_json      TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL,
      FOREIGN KEY(account_id) REFERENCES accounts(account_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      cid                 TEXT PRIMARY KEY,
      account_id          TEXT NOT NULL,
      aweme_id            TEXT NOT NULL,
      parent_cid          TEXT,
      root_cid            TEXT,
      text                TEXT NOT NULL,
      create_time         INTEGER,
      create_date         TEXT,
      digg_count          INTEGER,
      reply_comment_total INTEGER,
      user_uid            TEXT,
      user_sec_uid        TEXT,
      user_unique_id      TEXT,
      user_short_id       TEXT,
      user_nickname       TEXT,
      raw_json            TEXT,
      first_seen_at       TEXT NOT NULL,
      last_seen_at        TEXT NOT NULL,
      FOREIGN KEY(account_id) REFERENCES accounts(account_id),
      FOREIGN KEY(aweme_id) REFERENCES videos(aweme_id)
    );

    CREATE INDEX IF NOT EXISTS idx_comments_account_time ON comments(account_id, create_time);
    CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_sec_uid, user_uid, user_unique_id);
    CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(aweme_id);

    CREATE TABLE IF NOT EXISTS stock_dictionary (
      symbol       TEXT PRIMARY KEY,
      code         TEXT NOT NULL,
      exchange     TEXT NOT NULL,
      name         TEXT,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      source       TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_stock_dictionary_code ON stock_dictionary(code);
    CREATE INDEX IF NOT EXISTS idx_stock_dictionary_name ON stock_dictionary(name);

    CREATE TABLE IF NOT EXISTS stock_mentions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_cid    TEXT NOT NULL,
      account_id     TEXT NOT NULL,
      aweme_id       TEXT NOT NULL,
      user_stable_id TEXT NOT NULL,
      user_nickname  TEXT,
      symbol         TEXT NOT NULL,
      code           TEXT NOT NULL,
      exchange       TEXT NOT NULL,
      stock_name     TEXT,
      mention_text   TEXT NOT NULL,
      comment_time   INTEGER,
      comment_date   TEXT,
      created_at     TEXT NOT NULL,
      UNIQUE(comment_cid, symbol),
      FOREIGN KEY(comment_cid) REFERENCES comments(cid),
      FOREIGN KEY(symbol) REFERENCES stock_dictionary(symbol)
    );

    CREATE INDEX IF NOT EXISTS idx_stock_mentions_user ON stock_mentions(account_id, user_stable_id);
    CREATE INDEX IF NOT EXISTS idx_stock_mentions_symbol ON stock_mentions(symbol);
    CREATE INDEX IF NOT EXISTS idx_stock_mentions_time ON stock_mentions(comment_time);

    CREATE TABLE IF NOT EXISTS comment_signal_labels (
      comment_cid    TEXT PRIMARY KEY,
      label          TEXT NOT NULL,
      confidence     REAL,
      reason         TEXT,
      source         TEXT NOT NULL,
      model          TEXT,
      updated_at     TEXT NOT NULL,
      FOREIGN KEY(comment_cid) REFERENCES comments(cid) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_comment_signal_labels_label
      ON comment_signal_labels(label, source);

    CREATE TABLE IF NOT EXISTS evaluations (
      mention_id            INTEGER PRIMARY KEY,
      status                TEXT NOT NULL,
      baseline_date         TEXT,
      baseline_open         REAL,
      window_start_date     TEXT,
      window_end_date       TEXT,
      max_close             REAL,
      max_close_date        TEXT,
      max_close_return_pct  REAL,
      is_win                INTEGER,
      window_json           TEXT NOT NULL DEFAULT '[]',
      evaluated_at          TEXT NOT NULL,
      FOREIGN KEY(mention_id) REFERENCES stock_mentions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_stats (
      account_id              TEXT NOT NULL,
      user_stable_id          TEXT NOT NULL,
      user_nickname           TEXT,
      completed_mentions      INTEGER NOT NULL DEFAULT 0,
      pending_mentions        INTEGER NOT NULL DEFAULT 0,
      win_count               INTEGER NOT NULL DEFAULT 0,
      win_rate                REAL NOT NULL DEFAULT 0,
      avg_return_pct          REAL,
      total_return_pct        REAL,
      max_return_pct          REAL,
      latest_comment_time     INTEGER,
      tier                    TEXT NOT NULL DEFAULT 'normal',
      updated_at              TEXT NOT NULL,
      PRIMARY KEY(account_id, user_stable_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_stats_tier ON user_stats(tier, win_rate, completed_mentions);

    CREATE TABLE IF NOT EXISTS user_stats_global (
      user_stable_id          TEXT PRIMARY KEY,
      user_nickname           TEXT,
      account_count           INTEGER NOT NULL DEFAULT 0,
      account_ids_json        TEXT NOT NULL DEFAULT '[]',
      completed_mentions      INTEGER NOT NULL DEFAULT 0,
      pending_mentions        INTEGER NOT NULL DEFAULT 0,
      win_count               INTEGER NOT NULL DEFAULT 0,
      win_rate                REAL NOT NULL DEFAULT 0,
      avg_return_pct          REAL,
      total_return_pct        REAL,
      max_return_pct          REAL,
      latest_comment_time     INTEGER,
      tier                    TEXT NOT NULL DEFAULT 'normal',
      updated_at              TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_user_stats_global_tier
      ON user_stats_global(tier, win_rate, completed_mentions);

    CREATE TABLE IF NOT EXISTS alerts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      mention_id     INTEGER NOT NULL UNIQUE,
      account_id     TEXT NOT NULL,
      user_stable_id TEXT NOT NULL,
      alert_type     TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending',
      message        TEXT NOT NULL,
      channels_json  TEXT NOT NULL DEFAULT '[]',
      created_at     TEXT NOT NULL,
      sent_at        TEXT,
      error          TEXT,
      FOREIGN KEY(mention_id) REFERENCES stock_mentions(id) ON DELETE CASCADE
    );
  `);
}

export function upsertAccount(db, account) {
  const rawAccount = { ...account };
  delete rawAccount.crawl_since_date;
  db.prepare(
    `
    INSERT INTO accounts (
      account_id, display_name, profile_url, sec_user_id, since_date, enabled, raw_json, updated_at
    )
    VALUES (@account_id, @display_name, @profile_url, @sec_user_id, @since_date, @enabled, @raw_json, @updated_at)
    ON CONFLICT(account_id) DO UPDATE SET
      display_name=excluded.display_name,
      profile_url=excluded.profile_url,
      sec_user_id=excluded.sec_user_id,
      since_date=excluded.since_date,
      enabled=excluded.enabled,
      raw_json=excluded.raw_json,
      updated_at=excluded.updated_at
  `
  ).run({
    account_id: account.account_id,
    display_name: account.display_name || account.account_id,
    profile_url: account.profile_url,
    sec_user_id: account.sec_user_id,
    since_date: account.since_date,
    enabled: account.enabled === false ? 0 : 1,
    raw_json: JSON.stringify(rawAccount),
    updated_at: nowIso()
  });
}

export function upsertVideo(db, accountId, video) {
  const now = nowIso();
  const row = {
    aweme_id: String(video.aweme_id || video.awemeId || ""),
    account_id: accountId,
    desc: video.desc || "",
    create_time: Number(video.create_time || 0) || null,
    create_date: video.create_date || null,
    comment_count: Number(video.statistics?.comment_count ?? video.comment_count ?? 0) || 0,
    digg_count: Number(video.statistics?.digg_count ?? video.digg_count ?? 0) || 0,
    share_url: video.share_url || "",
    raw_json: JSON.stringify(video),
    first_seen_at: now,
    last_seen_at: now
  };
  if (!row.aweme_id) return;
  db.prepare(
    `
    INSERT INTO videos (
      aweme_id, account_id, desc, create_time, create_date, comment_count, digg_count,
      share_url, raw_json, first_seen_at, last_seen_at
    )
    VALUES (
      @aweme_id, @account_id, @desc, @create_time, @create_date, @comment_count, @digg_count,
      @share_url, @raw_json, @first_seen_at, @last_seen_at
    )
    ON CONFLICT(aweme_id) DO UPDATE SET
      account_id=excluded.account_id,
      desc=excluded.desc,
      create_time=excluded.create_time,
      create_date=excluded.create_date,
      comment_count=excluded.comment_count,
      digg_count=excluded.digg_count,
      share_url=excluded.share_url,
      raw_json=excluded.raw_json,
      last_seen_at=excluded.last_seen_at
  `
  ).run(row);
}

export function upsertComment(db, comment) {
  const now = nowIso();
  const row = {
    ...comment,
    reply_comment_total: Number(comment.reply_comment_total || 0) || 0,
    digg_count: Number(comment.digg_count || 0) || 0,
    raw_json: JSON.stringify(comment.raw || comment),
    first_seen_at: now,
    last_seen_at: now
  };
  if (!row.cid || !row.account_id || !row.aweme_id) return;
  db.prepare(
    `
    INSERT INTO comments (
      cid, account_id, aweme_id, parent_cid, root_cid, text, create_time, create_date,
      digg_count, reply_comment_total, user_uid, user_sec_uid, user_unique_id, user_short_id,
      user_nickname, raw_json, first_seen_at, last_seen_at
    )
    VALUES (
      @cid, @account_id, @aweme_id, @parent_cid, @root_cid, @text, @create_time, @create_date,
      @digg_count, @reply_comment_total, @user_uid, @user_sec_uid, @user_unique_id, @user_short_id,
      @user_nickname, @raw_json, @first_seen_at, @last_seen_at
    )
    ON CONFLICT(cid) DO UPDATE SET
      account_id=excluded.account_id,
      aweme_id=excluded.aweme_id,
      parent_cid=excluded.parent_cid,
      root_cid=excluded.root_cid,
      text=excluded.text,
      create_time=excluded.create_time,
      create_date=excluded.create_date,
      digg_count=excluded.digg_count,
      reply_comment_total=excluded.reply_comment_total,
      user_uid=excluded.user_uid,
      user_sec_uid=excluded.user_sec_uid,
      user_unique_id=excluded.user_unique_id,
      user_short_id=excluded.user_short_id,
      user_nickname=excluded.user_nickname,
      raw_json=excluded.raw_json,
      last_seen_at=excluded.last_seen_at
  `
  ).run(row);
}

export function upsertStock(db, stock) {
  const aliases = [...new Set((stock.aliases || []).filter(Boolean))];
  if (stock.name) aliases.push(stock.name);
  const row = {
    symbol: stock.symbol,
    code: stock.code,
    exchange: stock.exchange,
    name: stock.name || "",
    aliases_json: JSON.stringify([...new Set(aliases)]),
    source: stock.source || "manual",
    updated_at: nowIso()
  };
  if (!row.symbol || !row.code || !row.exchange) return;
  db.prepare(
    `
    INSERT INTO stock_dictionary (symbol, code, exchange, name, aliases_json, source, updated_at)
    VALUES (@symbol, @code, @exchange, @name, @aliases_json, @source, @updated_at)
    ON CONFLICT(symbol) DO UPDATE SET
      code=excluded.code,
      exchange=excluded.exchange,
      name=COALESCE(NULLIF(excluded.name, ''), stock_dictionary.name),
      aliases_json=excluded.aliases_json,
      source=excluded.source,
      updated_at=excluded.updated_at
  `
  ).run(row);
}

export function upsertMention(db, comment, stock, mentionText) {
  const result = db
    .prepare(
      `
      INSERT INTO stock_mentions (
        comment_cid, account_id, aweme_id, user_stable_id, user_nickname,
        symbol, code, exchange, stock_name, mention_text, comment_time, comment_date, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(comment_cid, symbol) DO UPDATE SET
        account_id=excluded.account_id,
        aweme_id=excluded.aweme_id,
        user_stable_id=excluded.user_stable_id,
        user_nickname=excluded.user_nickname,
        code=excluded.code,
        exchange=excluded.exchange,
        stock_name=excluded.stock_name,
        mention_text=excluded.mention_text,
        comment_time=excluded.comment_time,
        comment_date=excluded.comment_date
      WHERE
        stock_mentions.account_id IS NOT excluded.account_id OR
        stock_mentions.aweme_id IS NOT excluded.aweme_id OR
        stock_mentions.user_stable_id IS NOT excluded.user_stable_id OR
        stock_mentions.user_nickname IS NOT excluded.user_nickname OR
        stock_mentions.code IS NOT excluded.code OR
        stock_mentions.exchange IS NOT excluded.exchange OR
        stock_mentions.stock_name IS NOT excluded.stock_name OR
        stock_mentions.mention_text IS NOT excluded.mention_text OR
        stock_mentions.comment_time IS NOT excluded.comment_time OR
        stock_mentions.comment_date IS NOT excluded.comment_date
    `
    )
    .run(
      comment.cid,
      comment.account_id,
      comment.aweme_id,
      stableUserId(comment),
      comment.user_nickname,
      stock.symbol,
      stock.code,
      stock.exchange,
      stock.name,
      mentionText,
      comment.create_time,
      comment.create_date,
      nowIso()
    );
  return result.changes;
}

export function deleteMentionsForComment(db, commentCid) {
  if (!commentCid) return 0;
  const result = db
    .prepare("DELETE FROM stock_mentions WHERE comment_cid = ?")
    .run(commentCid);
  return result.changes;
}

export function getCommentSignalLabel(db, commentCid) {
  if (!commentCid) return null;
  return db
    .prepare("SELECT * FROM comment_signal_labels WHERE comment_cid = ?")
    .get(commentCid);
}

export function upsertCommentSignalLabel(db, label) {
  db.prepare(
    `
    INSERT INTO comment_signal_labels (
      comment_cid, label, confidence, reason, source, model, updated_at
    )
    VALUES (@comment_cid, @label, @confidence, @reason, @source, @model, @updated_at)
    ON CONFLICT(comment_cid) DO UPDATE SET
      label=excluded.label,
      confidence=excluded.confidence,
      reason=excluded.reason,
      source=excluded.source,
      model=excluded.model,
      updated_at=excluded.updated_at
  `
  ).run({
    comment_cid: label.comment_cid,
    label: label.label,
    confidence: label.confidence ?? null,
    reason: label.reason || "",
    source: label.source || "rules",
    model: label.model || "",
    updated_at: nowIso()
  });
}

export function syncMentionCommentFields(db) {
  const result = db.prepare(
    `
    UPDATE stock_mentions
    SET
      account_id = (SELECT c.account_id FROM comments AS c WHERE c.cid = stock_mentions.comment_cid),
      aweme_id = (SELECT c.aweme_id FROM comments AS c WHERE c.cid = stock_mentions.comment_cid),
      user_stable_id = (
        SELECT COALESCE(
          NULLIF(c.user_sec_uid, ''),
          NULLIF(c.user_uid, ''),
          NULLIF(c.user_unique_id, ''),
          NULLIF(c.user_short_id, ''),
          NULLIF(c.user_nickname, ''),
          'unknown'
        )
        FROM comments AS c
        WHERE c.cid = stock_mentions.comment_cid
      ),
      user_nickname = (SELECT c.user_nickname FROM comments AS c WHERE c.cid = stock_mentions.comment_cid),
      comment_time = (SELECT c.create_time FROM comments AS c WHERE c.cid = stock_mentions.comment_cid),
      comment_date = (SELECT c.create_date FROM comments AS c WHERE c.cid = stock_mentions.comment_cid)
    WHERE EXISTS (
      SELECT 1
      FROM comments AS c
      WHERE c.cid = stock_mentions.comment_cid
        AND (
          stock_mentions.account_id IS NOT c.account_id OR
          stock_mentions.aweme_id IS NOT c.aweme_id OR
          stock_mentions.user_stable_id IS NOT COALESCE(
            NULLIF(c.user_sec_uid, ''),
            NULLIF(c.user_uid, ''),
            NULLIF(c.user_unique_id, ''),
            NULLIF(c.user_short_id, ''),
            NULLIF(c.user_nickname, ''),
            'unknown'
          ) OR
          stock_mentions.user_nickname IS NOT c.user_nickname OR
          stock_mentions.comment_time IS NOT c.create_time OR
          stock_mentions.comment_date IS NOT c.create_date
        )
    )
  `
  ).run();
  return result.changes;
}

export function upsertEvaluation(db, evaluation) {
  db.prepare(
    `
    INSERT INTO evaluations (
      mention_id, status, baseline_date, baseline_open, window_start_date, window_end_date,
      max_close, max_close_date, max_close_return_pct, is_win, window_json, evaluated_at
    )
    VALUES (
      @mention_id, @status, @baseline_date, @baseline_open, @window_start_date, @window_end_date,
      @max_close, @max_close_date, @max_close_return_pct, @is_win, @window_json, @evaluated_at
    )
    ON CONFLICT(mention_id) DO UPDATE SET
      status=excluded.status,
      baseline_date=excluded.baseline_date,
      baseline_open=excluded.baseline_open,
      window_start_date=excluded.window_start_date,
      window_end_date=excluded.window_end_date,
      max_close=excluded.max_close,
      max_close_date=excluded.max_close_date,
      max_close_return_pct=excluded.max_close_return_pct,
      is_win=excluded.is_win,
      window_json=excluded.window_json,
      evaluated_at=excluded.evaluated_at
  `
  ).run({
    ...evaluation,
    window_json: JSON.stringify(evaluation.window || []),
    evaluated_at: nowIso()
  });
}

export function refreshUserStats(db) {
  const now = nowIso();
  const refresh = db.transaction(() => {
    db.prepare("DELETE FROM user_stats").run();
    db.prepare(
      `
      INSERT INTO user_stats (
        account_id, user_stable_id, user_nickname, completed_mentions, pending_mentions,
        win_count, win_rate, avg_return_pct, total_return_pct, max_return_pct,
        latest_comment_time, tier, updated_at
      )
      SELECT
        m.account_id,
        m.user_stable_id,
        COALESCE(MAX(m.user_nickname), '') AS user_nickname,
        SUM(CASE WHEN e.status='completed' THEN 1 ELSE 0 END) AS completed_mentions,
        SUM(CASE WHEN e.status='pending' THEN 1 ELSE 0 END) AS pending_mentions,
        SUM(CASE WHEN e.status='completed' AND e.is_win=1 THEN 1 ELSE 0 END) AS win_count,
        CASE
          WHEN SUM(CASE WHEN e.status='completed' THEN 1 ELSE 0 END) = 0 THEN 0
          ELSE 1.0 * SUM(CASE WHEN e.status='completed' AND e.is_win=1 THEN 1 ELSE 0 END)
            / SUM(CASE WHEN e.status='completed' THEN 1 ELSE 0 END)
        END AS win_rate,
        AVG(CASE WHEN e.status='completed' THEN e.max_close_return_pct ELSE NULL END) AS avg_return_pct,
        SUM(CASE WHEN e.status='completed' THEN e.max_close_return_pct ELSE 0 END) AS total_return_pct,
        MAX(CASE WHEN e.status='completed' THEN e.max_close_return_pct ELSE NULL END) AS max_return_pct,
        MAX(m.comment_time) AS latest_comment_time,
        'normal' AS tier,
        ? AS updated_at
      FROM stock_mentions AS m
      LEFT JOIN evaluations AS e ON e.mention_id = m.id
      GROUP BY m.account_id, m.user_stable_id
    `
    ).run(now);

    db.prepare(
      `
      UPDATE user_stats
      SET tier = CASE
        WHEN completed_mentions >= ${IGNORE_MIN_COMPLETED_MENTIONS} AND win_rate < ${IGNORE_MAX_WIN_RATE} THEN 'ignored'
        WHEN completed_mentions >= ${ALERT_MIN_COMPLETED_MENTIONS} AND win_rate >= ${ALERT_MIN_WIN_RATE} THEN 'elite'
        ELSE 'normal'
      END
    `
    ).run();

    db.prepare("DELETE FROM user_stats_global").run();
    const globalRows = db
      .prepare(
        `
        SELECT
          m.user_stable_id,
          COALESCE(
            (
              SELECT m2.user_nickname
              FROM stock_mentions AS m2
              WHERE m2.user_stable_id = m.user_stable_id
                AND COALESCE(m2.user_nickname, '') != ''
              ORDER BY m2.comment_time DESC, m2.id DESC
              LIMIT 1
            ),
            ''
          ) AS user_nickname,
          GROUP_CONCAT(DISTINCT m.account_id) AS account_ids,
          COUNT(DISTINCT m.account_id) AS account_count,
          SUM(CASE WHEN e.status='completed' THEN 1 ELSE 0 END) AS completed_mentions,
          SUM(CASE WHEN e.status='pending' THEN 1 ELSE 0 END) AS pending_mentions,
          SUM(CASE WHEN e.status='completed' AND e.is_win=1 THEN 1 ELSE 0 END) AS win_count,
          CASE
            WHEN SUM(CASE WHEN e.status='completed' THEN 1 ELSE 0 END) = 0 THEN 0
            ELSE 1.0 * SUM(CASE WHEN e.status='completed' AND e.is_win=1 THEN 1 ELSE 0 END)
              / SUM(CASE WHEN e.status='completed' THEN 1 ELSE 0 END)
          END AS win_rate,
          AVG(CASE WHEN e.status='completed' THEN e.max_close_return_pct ELSE NULL END) AS avg_return_pct,
          SUM(CASE WHEN e.status='completed' THEN e.max_close_return_pct ELSE 0 END) AS total_return_pct,
          MAX(CASE WHEN e.status='completed' THEN e.max_close_return_pct ELSE NULL END) AS max_return_pct,
          MAX(m.comment_time) AS latest_comment_time
        FROM stock_mentions AS m
        LEFT JOIN evaluations AS e ON e.mention_id = m.id
        GROUP BY m.user_stable_id
      `
      )
      .all();
    const insertGlobal = db.prepare(
      `
      INSERT INTO user_stats_global (
        user_stable_id, user_nickname, account_count, account_ids_json,
        completed_mentions, pending_mentions, win_count, win_rate,
        avg_return_pct, total_return_pct, max_return_pct, latest_comment_time,
        tier, updated_at
      )
      VALUES (
        @user_stable_id, @user_nickname, @account_count, @account_ids_json,
        @completed_mentions, @pending_mentions, @win_count, @win_rate,
        @avg_return_pct, @total_return_pct, @max_return_pct, @latest_comment_time,
        'normal', @updated_at
      )
    `
    );
    for (const row of globalRows) {
      insertGlobal.run({
        ...row,
        account_ids_json: JSON.stringify(
          String(row.account_ids || "")
            .split(",")
            .filter(Boolean)
            .sort()
        ),
        updated_at: now
      });
    }
    db.prepare(
      `
      UPDATE user_stats_global
      SET tier = CASE
        WHEN completed_mentions >= ${IGNORE_MIN_COMPLETED_MENTIONS} AND win_rate < ${IGNORE_MAX_WIN_RATE} THEN 'ignored'
        WHEN completed_mentions >= ${ALERT_MIN_COMPLETED_MENTIONS} AND win_rate >= ${ALERT_MIN_WIN_RATE} THEN 'elite'
        ELSE 'normal'
      END
    `
    ).run();
  });
  refresh();
}

export function getIgnoredUserKeys(db) {
  return new Set(
    db
      .prepare(
        `
        SELECT account_id || char(9) || user_stable_id AS key
        FROM user_stats
        WHERE tier='ignored'
           OR (completed_mentions >= ? AND win_rate < ?)
        UNION
        SELECT a.account_id || char(9) || g.user_stable_id AS key
        FROM user_stats_global AS g
        CROSS JOIN accounts AS a
        WHERE g.tier='ignored'
           OR (g.completed_mentions >= ? AND g.win_rate < ?)
      `
      )
      .all(
        IGNORE_MIN_COMPLETED_MENTIONS,
        IGNORE_MAX_WIN_RATE,
        IGNORE_MIN_COMPLETED_MENTIONS,
        IGNORE_MAX_WIN_RATE
      )
      .map((row) => row.key)
  );
}

export function getPendingAlertMentions(db) {
  return db
    .prepare(
      `
      SELECT
        m.*,
        s.tier,
        s.completed_mentions,
        s.win_count,
        s.win_rate,
        s.avg_return_pct,
        s.total_return_pct,
        gs.tier AS global_tier,
        gs.account_count AS global_account_count,
        gs.completed_mentions AS global_completed_mentions,
        gs.pending_mentions AS global_pending_mentions,
        gs.win_count AS global_win_count,
        gs.win_rate AS global_win_rate,
        gs.avg_return_pct AS global_avg_return_pct,
        gs.total_return_pct AS global_total_return_pct,
        a.display_name AS account_name,
        c.text AS comment_text,
        m.comment_date,
        v.desc AS video_desc,
        v.create_date AS video_create_date,
        e.status AS evaluation_status,
        e.max_close_return_pct
      FROM stock_mentions AS m
      JOIN user_stats AS s
        ON s.account_id = m.account_id AND s.user_stable_id = m.user_stable_id
      JOIN user_stats_global AS gs
        ON gs.user_stable_id = m.user_stable_id
      JOIN accounts AS a ON a.account_id = m.account_id
      JOIN comments AS c ON c.cid = m.comment_cid
      LEFT JOIN videos AS v ON v.aweme_id = m.aweme_id
      LEFT JOIN evaluations AS e ON e.mention_id = m.id
      LEFT JOIN alerts AS al ON al.mention_id = m.id
      WHERE al.id IS NULL
        AND s.tier != 'ignored'
        AND gs.tier != 'ignored'
        AND (
          (s.completed_mentions >= ? AND s.win_rate >= ?)
          OR (gs.completed_mentions >= ? AND gs.win_rate >= ?)
        )
        AND (e.status IS NULL OR e.status='pending')
      ORDER BY m.comment_time DESC
    `
    )
    .all(
      ALERT_MIN_COMPLETED_MENTIONS,
      ALERT_MIN_WIN_RATE,
      ALERT_MIN_COMPLETED_MENTIONS,
      ALERT_MIN_WIN_RATE
    );
}
