import assert from "node:assert/strict";
import {
  buildCard,
  catalogProviderURL,
  fallbackProviderURL,
  providerURLFromConfig,
  providerURLFromLayers,
  providerURLFromPatch,
  resolveEngine,
  resolveProviderBaseURL,
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

check("p0 a configured public provider is cloud when the header has no URL", () => {
  const patch = `
providers:
  local-box:
    baseURL: http://127.0.0.1:19420
  zhipu-coding:
    displayName: Zhipu Coding Plan
    baseURL: https://open.bigmodel.cn/api/coding/paas/v4
  other:
    baseURL: http://10.0.0.8:9
`;
  const config = {
    config: {
      providers: {
        "zhipu-coding": { baseURL: "https://open.bigmodel.cn/api/coding/paas/v4" },
        "local-box": { baseURL: "http://127.0.0.1:19420" },
      },
    },
  };
  assert.equal(providerURLFromPatch(patch, "zhipu-coding"), "https://open.bigmodel.cn/api/coding/paas/v4");
  assert.equal(providerURLFromPatch(patch, "local-box"), "http://127.0.0.1:19420");
  assert.equal(providerURLFromPatch(patch, "missing"), "");
  assert.equal(providerURLFromConfig(config, "zhipu-coding"), "https://open.bigmodel.cn/api/coding/paas/v4");
  const cloud = resolveProviderBaseURL({ provider: "zhipu-coding", patchText: patch });
  const local = resolveProviderBaseURL({ provider: "local-box", config });
  assert.equal(resolveEngine({ provider: "zhipu-coding", baseURL: cloud }).engine, "cloud");
  assert.equal(resolveEngine({ provider: "local-box", baseURL: local }).engine, "local");
  assert.equal(resolveProviderBaseURL({
    provider: "zhipu-coding",
    headerURL: "http://127.0.0.1:9",
    patchText: patch,
  }), "http://127.0.0.1:9");
  assert.equal(resolveProviderBaseURL({ provider: "custom" }), "");
  assert.equal(resolveEngine({ provider: "custom", baseURL: "" }).engine, "local");
  assert.equal(providerURLFromLayers([
    {
      override: { providers: { other: { baseURL: "http://10.0.0.8:9" } } },
      inherited: { providers: { "zhipu-coding": { baseURL: "https://open.bigmodel.cn/api/coding/paas/v4" } } },
    },
  ], "zhipu-coding"), "");
  const inline = `providers:\n  my-glm: { baseURL: https://example.test/v1, api: openai-completions }\n  desk: { baseURL: http://192.168.1.9:8080 }\n`;
  assert.equal(providerURLFromPatch(inline, "my-glm"), "https://example.test/v1");
  assert.equal(resolveEngine({ provider: "my-glm", baseURL: providerURLFromPatch(inline, "my-glm") }).engine, "cloud");
  assert.equal(resolveEngine({ provider: "desk", baseURL: providerURLFromPatch(inline, "desk") }).engine, "local");
  assert.equal(resolveProviderBaseURL({
    provider: "deepseek-official",
    config: { providers: { "deepseek-official": { baseURL: "http://127.0.0.1:8080" } } },
  }), "http://127.0.0.1:8080");
  assert.equal(resolveEngine({
    provider: "deepseek-official",
    baseURL: resolveProviderBaseURL({
      provider: "deepseek-official",
      config: { providers: { "deepseek-official": { baseURL: "http://127.0.0.1:8080" } } },
    }),
  }).engine, "local");
  assert.equal(catalogProviderURL("openai", [{ id: "openai", baseURL: "https://api.openai.com/v1" }]), "https://api.openai.com/v1");
  assert.equal(resolveProviderBaseURL({
    provider: "openai",
    catalog: [{ id: "openai", baseUrl: "https://api.openai.com/v1" }],
  }), "https://api.openai.com/v1");
  assert.equal(resolveEngine({
    provider: "openai",
    baseURL: resolveProviderBaseURL({
      provider: "openai",
      catalog: [{ id: "openai", baseURL: "https://api.openai.com/v1" }],
    }),
  }).engine, "cloud");
  assert.equal(resolveProviderBaseURL({
    provider: "openai",
    config: { providers: { openai: { baseURL: "http://10.1.2.3:9" } } },
    catalog: [{ id: "openai", baseURL: "https://api.openai.com/v1" }],
  }), "http://10.1.2.3:9");
  assert.equal(resolveEngine({ provider: "strata-box", baseURL: "https://api.example.com" }).engine, "local");
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

check("p0 cloud at 200000 still selects an old tool without a prior growth record", () => {
  const items = [];
  for (let index = 0; index < 6; index += 1) {
    items.push({ type: "user", tokens: 40 });
    items.push({ type: "tool", tokens: 12000 });
  }
  const cut = selectCutIndexes(items, {
    engine: "cloud",
    drain: false,
    totalTokens: 200000,
    maxEnd: 5,
  });
  assert.ok(cut);
  assert.equal(cut.end <= 5, true);
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
