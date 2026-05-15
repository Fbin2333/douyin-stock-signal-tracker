#!/usr/bin/env node

import { boolArg, intArg, parseArgs } from "../src/lib/cli.mjs";
import { getRuntimeConfig } from "../src/lib/config.mjs";
import { getDb } from "../src/lib/db.mjs";
import { resolveAbbreviationsForAllComments } from "../src/lib/abbreviation-resolver.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2), {});
  const config = getRuntimeConfig();
  const db = getDb();
  const result = await resolveAbbreviationsForAllComments(db, {
    signalAgent: config.signalAgent,
    limit: intArg(args, "limit", 0),
    minConfidence: Number(args.minConfidence || 0.7),
    dryRun: boolArg(args, "dryRun", false),
    term: args.term || "",
    since: args.since || "",
    firstSeenSince: args.firstSeenSince || ""
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
