/**
 * 唯一写 DSH 包名的地方。改宿主版本时，这里的符号和 package.json 的
 * engines/peerDependencies 一起改。
 * The only file that names a DSH package.
 *
 * 三个 loader 分开：谁缺谁失败，shell.js 才知道还能不能退到原版压缩。
 * 不走静态 export...from，否则 gate.js 在没有上游时也无法求值，fail-soft 会坏。
 * Three separate loaders; static re-export would break gate.js when a host lacks a package.
 * 不做版本探测，不做兜底：降级只发生在 shell.js。
 */

export const STOCK_ENGINE = "@deepseek-ai/dsh-compaction-basic";

export const loadBase = () => import("@deepseek-ai/dsh-compaction-basic");

export const loadCompaction = () => import("@deepseek-ai/dsh-compaction");

export const loadLlm = () => import("@deepseek-ai/dsh-llm");
