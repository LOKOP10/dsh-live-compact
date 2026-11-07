/**
 * 唯一写 DSH 包名的地方。换成别的宿主版本只改这里。
 * The only file that names a DSH package.
 *
 * 上游区间在 package.json：engines.dsh 与 peerDependencies，>=0.2.0-rc.2 <0.3.0。
 * adapter 只做搬名，不做版本探测、不做兜底、不做降级；加载失败由 shell.js 决定退到原版。
 * Names only. No version probe, no fallback: shell.js owns the degrade decision.
 */

export const STOCK_ENGINE = "@deepseek-ai/dsh-compaction-basic";

export async function loadUpstream() {
  const [basic, compaction, llm] = await Promise.all([
    import("@deepseek-ai/dsh-compaction-basic"),
    import("@deepseek-ai/dsh-compaction"),
    import("@deepseek-ai/dsh-llm"),
  ]);

  return {
    BasicCompactionEngine: basic.BasicCompactionEngine,
    CompactionEngine: compaction.CompactionEngine,
    ManualCompactionError: compaction.ManualCompactionError,
    CompactionId: compaction.CompactionId,
    toolPairingBalancedAfter: compaction.toolPairingBalancedAfter,
    toolPairingBalancedBefore: compaction.toolPairingBalancedBefore,
    createUserMessage: llm.createUserMessage,
  };
}
