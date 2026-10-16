# 逐曲响度均衡与部署版本

PowerfulTS 的音乐输出可按完整歌曲的综合响度统一音量。先开始播放，后台用 FFmpeg `ebur128` 分析整首 LUFS / 真峰值，分析完成后用 5 秒平滑过渡到 `min(targetLufs - input_i, -1 - input_tp, 12)` dB 的**常量 volume**播放。默认配置关闭，目标 −18 LUFS（范围 −24 至 −14）；线上已开启。整首固定增益，暂停、跳转保持增益，修改设置在下一首生效。不会按片段自动调节音量，也不使用动态压缩。

`GET/POST /api/bot/settings` 的 `loudnessNormalization` 持久化设置并更新所有机器人；播放状态返回分析/已应用/失败及固定增益。实时麦克风、外部连续 PCM / Spotify FIFO 不处理。完整音源分析最多 300 秒，失败保持原始增益；停止/切歌取消分析，相同 URL 的测量缓存 15 分钟、最多 64 项。HTTP 预分析移除 `reconnect_at_eof`，确保 EOF 返回统计结果；播放网络恢复参数保留。

## 发布与维护分支

- `main` / Docker `:1.12.3` 和 `:latest`：整合通用分支及生产兼容分支的后台分析、平滑增益和 PCM 语音闪避。

- `merge/upstream-v1.12`：包含同步上游 v1.15.2 后的通用实现和 CDN 恢复适配。
- `codex/audio-production-compatible`：2026-10-10 实际上线的引擎源码。源代码快照逐文件对照后确认等同于历史提交 `2c1fc74fce812caaaa79b5e8566a7dd617c1e9ad`；响度功能在此基线上移植，保留原 TS 连接层。当前服务器更新应沿用此分支的已验收固定提交。通用分支的连接层切换仍需单独验证。

功能已提交到这两条分支，更新时无需再次应用 PowerfulTS 仓库中的历史补丁。不要用原版上游镜像直接覆盖定制引擎。同步上游需保留 `src/audio/track-loudness.ts`、AudioPlayer 的固定增益/取消/续播逻辑、config 与 bot settings/status 接口，并通过下列回归测试；保留实际 `config.json` / 数据卷中的启用设置。不要提交服务器凭据、Cookie、identity 或数据库。

```sh
npm ci
npx vitest run src/audio/track-loudness.test.ts src/audio/player.test.ts src/data/config.test.ts src/web/api/bot.test.ts src/bot/instance.test.ts
npx tsc --noEmit
npm run build
```

测试包含真实 FFmpeg 文件与 HTTP 分析、不同歌曲响度匹配、曲内动态比例、峰值/静音、取消/失败、跳转固定增益及配置/API。具体部署和回退记录见 [PowerfulTS 部署记录](https://github.com/Slldyd2077/PowerfulTS/blob/main/docs/audio-deployment-2026-10-10.md)，网页 RNNoise 降噪由 PowerfulTS 前端承担。
