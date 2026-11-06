import assert from "node:assert/strict";
import {
  buildCard,
  fallbackProviderURL,
  resolveEngine,
  selectCutIndexes,
} from "../plan.js";

const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error(`not ok ${name}`);
    console.error(error);
  }
}

function numberedLog(lines = 520) {
  const body = [];
  for (let index = 0; index < lines; index += 1) {
    body.push(`${index + 1}: INFO 2026-11-04 svc=ledger seq=03-${String(index).padStart(4, "0")} heartbeat ok`);
  }
  body[180] = "181: WARN ledger drift turn=3 n=0";
  body[260] = "261: NOTICE cache layer pinned to sqlite";
  return `<path>/tmp/x/part3.log</path>\n<content>\n${body.join("\n")}`;
}

check("p0 official DeepSeek is cloud when the header has no URL", () => {
  const baseURL = fallbackProviderURL("deepseek-official");
  assert.equal(baseURL, "https://api.deepseek.com/anthropic");
  assert.equal(resolveEngine({ provider: "deepseek-official", baseURL }).engine, "cloud");
  assert.equal(resolveEngine({ provider: "deepseek", baseURL: fallbackProviderURL("deepseek") }).engine, "cloud");
  assert.equal(resolveEngine({ provider: "custom", baseURL: "" }).engine, "local");
});

check("p0 numbered heartbeat log can be cut", () => {
  const text = numberedLog();
  const card = buildCard(text, "", [{ role: "tool", text, toolCallId: "call-log", known: true, seq: 41 }]);
  assert.equal(card.ok, true);
  assert.equal(card.missing.length, 0);
  assert.equal(card.omittedOrdinaryToolLines > 0, true);
});

check("p0 a heartbeat line carrying a fact cannot pass while the fact is missing", () => {
  const line = "12: INFO 2026-11-04 svc=ledger seq=03-0156 heartbeat ok region=cn-north-7";
  const card = buildCard(line, "", [{ role: "tool", text: line, toolCallId: "call-fact", known: true, seq: 42 }]);
  assert.equal(card.ok && !card.text.includes("cn-north-7"), false);
});

check("p0 user obligation missing from the card cancels the cut", () => {
  const line = "必须保留 ledger.txt，不要删。口令 KESTREL-4419。";
  const card = buildCard("", "", [{ role: "user", text: line }]);
  assert.equal(card.ok, true);
  assert.equal(card.text.includes("必须保留 ledger.txt"), true);
  assert.equal(card.text.includes("KESTREL-4419"), true);
});

check("p0 local cut does not cross the last user", () => {
  const items = [
    { type: "tool", tokens: 8000 },
    { type: "user", tokens: 120 },
    { type: "tool", tokens: 300 },
  ];
  const cut = selectCutIndexes(items, { engine: "local", totalTokens: 90000, drain: true });
  if (cut) {
    assert.equal(cut.start > 1, true);
    assert.equal(cut.end > 1, true);
  }
});

check("p0 cut does not walk across a checkpoint to gather 1000", () => {
  const items = [
    { type: "tool", tokens: 600 },
    { type: "tool", tokens: 600, checkpoint: true },
    { type: "tool", tokens: 1500 },
    { type: "assistant", tokens: 10 },
  ];
  const cut = selectCutIndexes(items, { engine: "cloud", drain: true, totalTokens: 200000 });
  assert.ok(cut);
  assert.equal(cut.start, 2);
  assert.equal(cut.end, 2);
  for (let index = cut.start; index <= cut.end; index += 1) {
    assert.equal(items[index].checkpoint, undefined);
  }
});

check("p0 cloud ordinary turn does not cut history", () => {
  const items = [];
  for (let index = 0; index < 6; index += 1) items.push({ type: "tool", tokens: 8000 });
  assert.equal(selectCutIndexes(items, { engine: "cloud", drain: false, totalTokens: 40000 }), null);
});

check("p0 drain still selects a cut when context is 200000", () => {
  const items = [];
  for (let index = 0; index < 6; index += 1) items.push({ type: "tool", tokens: 15000 });
  items.push({ type: "user", tokens: 80 });
  items.push({ type: "tool", tokens: 15000 });
  const cut = selectCutIndexes(items, {
    engine: "cloud",
    drain: true,
    totalTokens: 200000,
    maxEnd: 5,
  });
  assert.ok(cut);
  assert.equal(cut.end <= 5, true);
});

if (failures.length) {
  console.error(`p0 blockers failed: ${failures.length}`);
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log("p0 blockers passed");
