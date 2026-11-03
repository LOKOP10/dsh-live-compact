const STOCK = "@deepseek-ai/dsh-compaction-basic";
const OURS = "dsh-live-compact";
const PRESET_IDS = new Set(["standard", "ptc", "minimal", "cordis"]);
export const GATE_SERVICE = "liveCompactPresetGate";

function rewriteEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const next = { ...entry };
  if (entry.name === STOCK) next.name = OURS;
  if (Array.isArray(entry.config)) next.config = entry.config.map(rewriteEntry);
  else if (entry.config && typeof entry.config === "object") next.config = rewriteNode(entry.config);
  return next;
}

function rewriteNode(node) {
  if (Array.isArray(node)) return node.map(rewriteEntry);
  if (!node || typeof node !== "object") return node;
  const next = { ...node };
  if (Array.isArray(node.plugins)) next.plugins = node.plugins.map(rewriteEntry);
  if (Array.isArray(node.config)) next.config = node.config.map(rewriteEntry);
  return next;
}

export function rewritePresetConfig(config) {
  if (!config || !PRESET_IDS.has(config.id)) return config;
  return rewriteNode(config);
}

export default class LiveCompactGate {
  constructor(ctx) {
    ctx.on("internal/config", function (_raw, next) {
      const resolved = next();
      try {
        return rewritePresetConfig(resolved);
      } catch {
        return resolved;
      }
    }, { global: true });
    ctx.provide(GATE_SERVICE, {});
  }
}
