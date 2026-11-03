# 边做边压 Live Compact

DeepSeek Harness 用到后面，上下文会一直堆。原版要等到窗口大约 80% 才压缩。那一刀要调模型，会话越长，这一刀越慢。压完没多久又满了，再压一次更慢。上下文一长，注意力就飘。

边做边压是边跑边切。超过 2 万 token 就切一刀，不调用模型。切的是刚结束的这一轮，切点前面的原文不动，DeepSeek 原来的高缓存命中率保住。

上下文因此一直停在较低的水平。就算后面满了，触发雷霆大压缩，也不会很快又涨回很高。全程缓存命中保持原来的水准。

## 安装

```sh
dsh plugin --profile <name> add github:MerkyorLynn/dsh-live-compact
```

需要 DSH `>=0.2.0-rc.2 <0.3.0`。装上后跑长任务，日志里出现 `spine cut …ms` 才算这刀生效。

DSH-TUI 先不要装。它的预设里还挂着原版压缩，这个包换不掉。

被切掉的原文会明文写到 `~/.dsh/compaction-spine/shadow`，只增不删，要自己清理。

MIT，见 `LICENSE`。
