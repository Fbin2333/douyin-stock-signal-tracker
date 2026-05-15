#!/usr/bin/env node

import { getDb } from "../src/lib/db.mjs";
import { getRuntimeConfig, loadAccounts } from "../src/lib/config.mjs";
import { crawlAccounts, summarizeCrawlResults } from "../src/lib/douyin-crawler.mjs";
import { boolArg, intArg, parseArgs } from "../src/lib/cli.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2), { account: "all" });
  const config = getRuntimeConfig();
  const db = getDb();
  const accounts = loadAccounts({
    account: args.account || "all",
    since: args.since || ""
  });

  const results = await crawlAccounts(db, accounts, {
    profileDir: args.profileDir || config.douyinProfileDir,
    headless: boolArg(args, "headless", true),
    apiMode: boolArg(args, "api", true) && !boolArg(args, "uiScroll", false),
    skipComments: boolArg(args, "skipComments", false),
    noReplies: boolArg(args, "replies", true) === false || boolArg(args, "noReplies", false),
    maxVideos: intArg(args, "maxVideos", 0),
    maxProfilePages: intArg(args, "maxProfilePages", 0),
    maxProfileScrolls: intArg(args, "maxProfileScrolls", 160),
    maxCommentPages: intArg(args, "maxCommentPages", 0),
    maxCommentScrolls: intArg(args, "maxCommentScrolls", 0),
    maxReplyPages: intArg(args, "maxReplyPages", 0),
    commentPageSize: intArg(args, "commentPageSize", 50),
    replyPageSize: intArg(args, "replyPageSize", 50),
    profilePageSize: intArg(args, "profilePageSize", 18),
    apiDelayMs: intArg(args, "apiDelayMs", 250),
    apiTimeoutMs: intArg(args, "apiTimeoutMs", 30000),
    maxReplyClicksPerLoop: intArg(args, "maxReplyClicksPerLoop", 8)
  });

  console.log(JSON.stringify(summarizeCrawlResults(results), null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
