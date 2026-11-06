# 8 组 31 轮

这套题要连模型。门禁 `npm run test:gate` 不连模型。发布到 GitHub 的测试集包含这两部分。

通过标准是三项：184 题全对且跳过为 0，前缀缓存不低于 98.23%，题末最高不超过 35963。

默认 DeepSeek 配置使用 `deepseek-flash`，也就是 V4.1 Flash。之后的连模型测试可以用 GLM-5.3 Flash，或把 `SPINE_ENGINE=local` 打到本地 27B。密钥放在环境变量里，不进仓库。

```bash
export LIVE_ROOT=/tmp/live-fill
export DSH_HOME=/path/to/dsh-home
export DSH_PROFILE=lc106long
bash test/live-fill/run_all.sh
```
