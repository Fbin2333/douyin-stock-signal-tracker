#!/usr/bin/env node

import { parseArgs, intArg, boolArg } from "../src/lib/cli.mjs";
import { getRuntimeConfig } from "../src/lib/config.mjs";
import {
  getCommentSignalLabel,
  getDb,
  upsertCommentSignalLabel
} from "../src/lib/db.mjs";
import { classifyMentionContext, extractRawStockMentions } from "../src/lib/mentions.mjs";
import { getDictionaryTerms } from "../src/lib/stock-data.mjs";
import { classifyWithSemanticAgent } from "../src/lib/semantic-agent.mjs";

function shouldSkipByMode({ existing, rule, only }) {
  if (only === "all") return false;
  if (only === "unclassified" && existing) return true;
  if (only === "ambiguous" && !rule.needsAgent) return true;
  return false;
}

async function classifyRow({ row, rawMentions, mode, config }) {
  const rule = classifyMentionContext(row.text);
  if (mode === "rules") {
    return { ...rule, source: "rules", model: "" };
  }
  if (mode === "agent") {
    return classifyWithSemanticAgent(row, rawMentions, config.signalAgent);
  }
  if (mode === "hybrid") {
    if (!rule.needsAgent) return { ...rule, source: "rules", model: "" };
    return classifyWithSemanticAgent(row, rawMentions, config.signalAgent);
  }
  throw new Error(`Unknown classify mode: ${mode}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    mode: "rules",
    only: "unclassified"
  });
  const mode = String(args.mode || "rules");
  const only = String(args.only || "unclassified");
  const limit = intArg(args, "limit", 0);
  const dryRun = boolArg(args, "dryRun", false);
  const config = getRuntimeConfig();
  const db = getDb();
  const dictionaryTerms = getDictionaryTerms(db);
  const comments = db
    .prepare(
      `
      SELECT
        c.*,
        v.create_date AS video_create_date,
        v.desc AS video_desc
      FROM comments AS c
      LEFT JOIN videos AS v ON v.aweme_id = c.aweme_id
      ORDER BY c.create_time ASC, c.cid ASC
    `
    )
    .all();

  let scanned = 0;
  let stockComments = 0;
  let classified = 0;
  let skippedExisting = 0;
  let skippedMode = 0;
  const labelCounts = {};

  for (const row of comments) {
    scanned += 1;
    const rawMentions = extractRawStockMentions(row.text, dictionaryTerms);
    if (rawMentions.length === 0) continue;
    stockComments += 1;

    const existing = getCommentSignalLabel(db, row.cid);
    const rule = classifyMentionContext(row.text);
    if (only === "unclassified" && existing) {
      skippedExisting += 1;
      continue;
    }
    if (shouldSkipByMode({ existing, rule, only })) {
      skippedMode += 1;
      continue;
    }

    const classification = await classifyRow({ row, rawMentions, mode, config });
    labelCounts[classification.label] = (labelCounts[classification.label] || 0) + 1;
    classified += 1;

    if (dryRun) {
      console.log(
        JSON.stringify(
          {
            cid: row.cid,
            text: row.text,
            mentions: rawMentions.map((item) => item.symbol),
            classification
          },
          null,
          2
        )
      );
    } else {
      upsertCommentSignalLabel(db, {
        comment_cid: row.cid,
        label: classification.label,
        confidence: classification.confidence,
        reason: classification.reason,
        source: classification.source,
        model: classification.model
      });
    }

    if (limit > 0 && classified >= limit) break;
  }

  console.log(
    JSON.stringify(
      {
        mode,
        only,
        dryRun,
        scanned,
        stockComments,
        classified,
        skippedExisting,
        skippedMode,
        labelCounts
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
