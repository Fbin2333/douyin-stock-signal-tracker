import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadAccounts } from "../src/lib/config.mjs";

test("command since overrides only crawl window, not configured account since date", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "douyin-accounts-"));
  const accountsPath = path.join(tempDir, "accounts.json");
  const previousAccountsPath = process.env.ACCOUNTS_PATH;

  try {
    process.env.ACCOUNTS_PATH = accountsPath;
    await writeFile(
      accountsPath,
      JSON.stringify([
        {
          account_id: "sample",
          display_name: "Sample",
          profile_url: "https://www.douyin.com/user/sec-sample",
          sec_user_id: "sec-sample",
          since_date: "2025-01-04",
          enabled: true
        }
      ])
    );

    const [account] = loadAccounts({ account: "sample", since: "2026-04-27" });
    assert.equal(account.since_date, "2025-01-04");
    assert.equal(account.crawl_since_date, "2026-04-27");
  } finally {
    if (previousAccountsPath == null) delete process.env.ACCOUNTS_PATH;
    else process.env.ACCOUNTS_PATH = previousAccountsPath;
    await rm(tempDir, { recursive: true, force: true });
  }
});
