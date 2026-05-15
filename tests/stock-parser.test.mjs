import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAbbreviationIndex,
  findAbbreviationCandidates
} from "../src/lib/abbreviation-resolver.mjs";
import { classifyMentionContext, extractStockMentions } from "../src/lib/mentions.mjs";

const dictionaryTerms = [
  {
    term: "新中港",
    normalized: "新中港",
    stock: { symbol: "605162.SH", code: "605162", exchange: "SH", name: "新中港" }
  },
  {
    term: "雪人集团",
    normalized: "雪人集团",
    stock: { symbol: "002639.SZ", code: "002639", exchange: "SZ", name: "雪人集团" }
  },
  {
    term: "雪人股份",
    normalized: "雪人股份",
    stock: { symbol: "002639.SZ", code: "002639", exchange: "SZ", name: "雪人集团" }
  },
  {
    term: "川润股份",
    normalized: "川润股份",
    stock: { symbol: "002272.SZ", code: "002272", exchange: "SZ", name: "川润股份" }
  },
  {
    term: "乐惠国际",
    normalized: "乐惠国际",
    stock: { symbol: "603076.SH", code: "603076", exchange: "SH", name: "乐惠国际" }
  }
];

test("extracts known A-share aliases from comments", () => {
  const samples = [
    ["新中港后面还有戏", ["605162.SH"]],
    ["雪人集团下午涨停，给我上烟", ["002639.SZ"]],
    ["雪人股份后面还有戏", ["002639.SZ"]],
    ["川润股份和乐惠国际", ["002272.SZ", "603076.SH"]]
  ];

  for (const [text, expected] of samples) {
    const symbols = extractStockMentions(text, dictionaryTerms)
      .map((item) => item.symbol)
      .sort();
    assert.deepEqual(symbols, expected.sort());
  }
});

test("extracts six-digit A-share codes", () => {
  const mentions = extractStockMentions("明天看 002639 和 605162", dictionaryTerms).map(
    (item) => item.symbol
  );
  assert.equal(mentions.includes("002639.SZ"), true);
  assert.equal(mentions.includes("605162.SH"), true);
});

test("filters consultation and post-hoc stock mentions", () => {
  const samples = [
    "雪人集团能买吗？",
    "老师，新中港怎么看？",
    "我3号推荐的雪人集团你没买吗？",
    "我几天前就说了新中港"
  ];

  for (const text of samples) {
    assert.deepEqual(extractStockMentions(text, dictionaryTerms), []);
    assert.equal(classifyMentionContext(text).isSignal, false);
  }
});

test("builds stock abbreviation candidates from Chinese prefix and pinyin initials", () => {
  const index = buildAbbreviationIndex([
    {
      symbol: "002342.SZ",
      code: "002342",
      exchange: "SZ",
      name: "巨力索具",
      aliases: []
    }
  ]);

  assert.deepEqual(
    findAbbreviationCandidates("巨力今天绝绝子", index).map((item) => item.symbol),
    ["002342.SZ"]
  );
  assert.deepEqual(
    findAbbreviationCandidates("麻烦问一下大哥，JLSJ", index).map((item) => item.symbol),
    ["002342.SZ"]
  );
});
