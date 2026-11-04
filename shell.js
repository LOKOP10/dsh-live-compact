// Thin entry. This file must evaluate even when the engine cannot load.
// A throw here leaves stock disabled and /compact waiting.

let Engine = null;
let Stock = null;
let CompactionEngine = null;
let ManualCompactionError = null;
let loadError = null;

if (process.env.SPINE_ENGINE_FAIL === "import") {
  loadError = new Error("spine: engine import refused");
} else {
  try {
    const engine = await import("./index.js");
    Engine = engine.default;
  } catch (error) {
    loadError = error instanceof Error ? error : new Error(String(error));
  }
}

try {
  const compaction = await import("@deepseek-ai/dsh-compaction");
  CompactionEngine = compaction.CompactionEngine;
  ManualCompactionError = compaction.ManualCompactionError;
} catch (error) {
  loadError ??= error instanceof Error ? error : new Error(String(error));
}

try {
  const stock = await import("@deepseek-ai/dsh-compaction-basic");
  Stock = stock.BasicCompactionEngine;
} catch (error) {
  if (!loadError) loadError = error instanceof Error ? error : new Error(String(error));
}

function reasonText(error) {
  return error instanceof Error ? error.message : String(error);
}

const MARK = "本会话未接管";

const UnavailableCompaction = CompactionEngine
  ? class extends CompactionEngine {
    constructor(ctx, reason) {
      super(ctx);
      this.reason = reason;
      ctx.logger?.warn?.(`spine: ${MARK}。压缩没有装上，这一刀没有执行。${reason}`);
    }

    compactIfNeeded() {
      return Promise.reject(new Error(`spine: ${MARK}。压缩没有装上，这一刀没有执行。${this.reason}`));
    }

    compactNow() {
      const message = `spine: ${MARK}。压缩没有装上，这一刀没有执行。${this.reason}`;
      if (ManualCompactionError) return Promise.reject(new ManualCompactionError("summary", message));
      return Promise.reject(new Error(message));
    }
  }
  : null;

export default class LiveCompactEntry {
  static inject = ["llm", "tokenMeter", "sessions"];

  constructor(ctx, config) {
    let cause = loadError;
    if (process.env.SPINE_ENGINE_FAIL === "construct") {
      cause = new Error("spine: constructor refused");
    } else if (Engine) {
      try {
        return new Engine(ctx, config);
      } catch (error) {
        cause = error instanceof Error ? error : new Error(String(error));
      }
    }
    cause ??= new Error("spine: engine missing");
    if (process.env.SPINE_STOCK_FAIL !== "1" && Stock) {
      try {
        ctx.logger?.warn?.(`spine: ${MARK}，这一轮用原版压缩。${reasonText(cause)}`);
        return new Stock(ctx, config);
      } catch (error) {
        cause = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (!UnavailableCompaction) throw new Error(`spine: ${MARK}。压缩接口没有装上。${reasonText(cause)}`);
    return new UnavailableCompaction(ctx, reasonText(cause));
  }
}
