import assert from "node:assert/strict";
import { test } from "node:test";

const gateUrl = new URL("../gate.js", import.meta.url);
let importId = 0;

function rewrittenEngineConfig(rewritePresetConfig) {
  const rewritten = rewritePresetConfig({
    id: "standard",
    plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }],
  }, true);
  return rewritten.plugins[0].config;
}

test("gate 使用三项配置的默认值", async () => {
  const keys = ["SPINE_THRESHOLD_RATIO", "SPINE_HEADROOM_TOKENS", "SPINE_RETAIN_TOKENS"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];

  try {
    const { rewritePresetConfig } = await import(`${gateUrl.href}?config=${importId++}`);
    const config = rewrittenEngineConfig(rewritePresetConfig);
    assert.strictEqual(config.thresholdRatio, 0.8);
    assert.strictEqual(config.headroomTokens, 65536);
    assert.strictEqual(config.retainTokens, 8192);
  } finally {
    for (const key of keys) {
      if (previous.get(key) === undefined) delete process.env[key];
      else process.env[key] = previous.get(key);
    }
  }
});

test("gate 在加载时读取 SPINE_HEADROOM_TOKENS 并复制数字", async () => {
  const previous = process.env.SPINE_HEADROOM_TOKENS;
  process.env.SPINE_HEADROOM_TOKENS = "16384";

  try {
    const { rewritePresetConfig } = await import(`${gateUrl.href}?config=${importId++}`);
    const config = rewrittenEngineConfig(rewritePresetConfig);
    assert.strictEqual(config.headroomTokens, 16384);
  } finally {
    if (previous === undefined) delete process.env.SPINE_HEADROOM_TOKENS;
    else process.env.SPINE_HEADROOM_TOKENS = previous;
  }
});
