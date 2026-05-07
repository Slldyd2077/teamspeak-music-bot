# 自定义机器人头像 + 专辑搜索/播放

**Date:** 2026-05-07
**Status:** Spec — pending implementation
**Issue:** [#51](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot/issues/51)

## Problem

Issue #51 的两个独立但同源的反馈：

1. **机器人头像无法固定** — 当前 `ProfileConfig.avatarEnabled` 控制是否同步专辑封面，但没有任何"上传一张固定头像"的入口。多 bot 房间里用户依赖头像辨识具体 bot，封面跟着歌变会让识别成本变高。
2. **网页端搜索不能播放整张专辑** — `SearchResult.albums` 类型字段存在但所有 provider 都返回 `[]`，搜索 API `/search/all` 只聚合 `songs`；Search.vue 里也只渲染 SongCard。Netease 后端 `getAlbumSongs` 已实现，唯独缺把搜索/UI 连起来。

两件事独立，分两个 PR；本 spec 同时覆盖两块以保持 #51 的单一 issue 关系。

## Goal

### 自定义头像

- "创建新实例"弹窗里有一个"自定义头像"上传/预览控件（PNG/JPG/WebP，≤200 KB，与 TS3 头像上限一致）
- Settings 已有的"同步头像"那行下面增加同等的"自定义头像"卡片，可以在已存在的 bot 上随时改/删
- 行为矩阵：

  | `avatarEnabled` | 有自定义 | 播放时 | 停播时 |
  |---|---|---|---|
  | true  | 是 | 跟当前歌曲封面 | **回到自定义** |
  | true  | 否 | 跟当前歌曲封面 | 清空（保持现状） |
  | false | 是 | 一直显示自定义 | 一直显示自定义 |
  | false | 否 | 不主动改 | 不主动改 |

### 专辑搜索

- 搜索结果里能看到"专辑"分区（先支持 Netease + QQ，bilibili/youtube 仍返回 `[]`）
- 点专辑卡片进入详情页 → 看到曲目列表 + 顶部"播放全部 / 加入队列"

## Out of Scope

- 头像格式自动转换（用户传 GIF/BMP 不接受，前端校验拒掉）
- 头像服务端自动 resize（本期保持"上传时校验大小"，后期可加 sharp/jimp 但不在本期）
- 专辑搜索的多平台聚合排序（按 `netease → qq` 简单拼接，与现有 `songs` 聚合一致）
- 专辑详情页的"喜欢/收藏"按钮（playlist 详情页本身也没有）
- 专辑作为推荐位（Home 不出现"推荐专辑"这一栏）
- bilibili / youtube 的专辑概念（这两个平台无对应 API）

## Architecture

### 自定义头像

#### 存储

- 文件落地 `data/avatars/<botId>.<ext>`（仿 `data/cookies/<platform>.json`，Docker volume 友好）
- DB schema：`bot_instances` 表新增 `custom_avatar_path` TEXT NULL（存相对路径，如 `avatars/<botId>.png`），通过 `migrateSchema()` 迁移
- 加载时机：`BotProfileManager` 构造时把文件读到内存 `Buffer`，避免每次 stop 都读盘

#### 后端 API

新增 `src/web/api/bot.ts` 里（如不存在则在 `instance.ts` 同源处）：

- `POST /api/bot/:id/avatar` (multipart) — 校验大小 ≤200 KB、MIME ∈ {png,jpeg,webp}；写盘 + 更新 DB；广播给运行中实例（重新加载 buffer + 立即 `applyIdleAvatar()`）
- `DELETE /api/bot/:id/avatar` — 删盘 + 清 DB；运行中实例切回原 clear 语义
- `GET /api/bot/:id/avatar` — 直接 `res.sendFile`（带强 ETag）供前端预览

#### `BotProfileManager` 改动

新增字段 + 方法：

```ts
private customAvatar: Buffer | null = null;

setCustomAvatar(buf: Buffer | null): void;
private async applyIdleAvatar(gen: number): Promise<void>;  // 上传 customAvatar
```

修改：

- `clearAvatar(gen)` → `if (this.customAvatar) { applyIdleAvatar(gen) } else { 当前逻辑 }`
- `onConnect()` 新增：`if (!avatarEnabled && customAvatar) applyIdleAvatar(gen)`
- `setCustomAvatar(buf)`：更新内存 buffer，并触发 `applyIdleAvatar` 一次（仅当当前应该显示 idle avatar 时，即没在播放或 avatarEnabled=false）

#### 前端

新组件 `web/src/components/AvatarUpload.vue`：

- props: `botId?` (上传时空表示走临时 base64 缓存)、`v-model:value`
- 拖拽 / 文件选择 / 预览圆框 / 删除按钮
- 内部 `axios.post('/api/bot/<id>/avatar', formData)` 或在创建表单里把 base64 与表单一同提交

接入点：

- 创建实例弹窗（搜索 `BotEditor.vue` 或类似）—— 表单提交后用返回的 botId 再 POST 头像；或者表单本身保存 base64 等创建完成后由后端解码落盘
- Settings.vue：在 features 列表中插入一行"自定义头像"，右侧渲染 `<AvatarUpload :bot-id="botId" />`

### 专辑搜索 / 详情

#### 后端

`src/music/netease.ts` `search()`：

- 多发一个 `cloudsearch?type=10` 请求，把返回的 `result.albums[]` 映射成 `Album[]` 填进 `SearchResult.albums`
- 字段 `id` / `name` / `coverUrl` (`picUrl`) / `artist` (`artists[].name.join(' / ')`)

`src/music/qq.ts` `search()`：

- 在现有 `req_0` 旁增加 `req_album: { module: "music.search.SearchCgiService", method: "DoSearchForQQMusicDesktop", param: { searchid, query, search_type: 8 } }`，映射 `body.album.list[]`

`src/web/api/music.ts` `/search/all`：

- 在响应里增加 `albums` 和 `playlists`，与 `songs` 一同合并

`/album/:id` 已存在，无需改动。

#### 前端

- `web/src/views/Search.vue`：响应 schema 升级为 `{songs, albums, playlists}`；模板加入两个新分区（"专辑"、"歌单"），各自一个简单的卡片网格（参考 Home.vue 的 `playlist-grid`）
- 新路由 `/album/:id` → 复用 `Playlist.vue`，把它的 `loadPlaylist()` 重构为根据 `route.path` 决定调 `/playlist/:id` 还是 `/album/:id`，或者新建 `Album.vue` 内部 import 同一个 `<PlaylistDetail />` 子组件
  - **方案选择**：拆出 `<PlaylistDetail :endpoint="...">` 组件 + `Album.vue` / `Playlist.vue` 两个薄壳。当前 `Playlist.vue` 内部仅 ~60 行模板，单文件改造比新建 PlaylistDetail 子组件更小，先用最小改动：在 `Playlist.vue` 内根据 `route.meta.kind === 'album'` 切换 endpoint
- 路由：`router/index.ts` 加 `{ path: '/album/:id', component: Playlist, meta: { kind: 'album' } }`

### 拆分

**两个 PR：**

1. `feat(profile): custom bot avatar with idle/playback precedence`
   - DB migration + ProfileManager 改动 + 上传 API + AvatarUpload.vue + 接入两个表单
2. `feat(search): album section in search results + album detail playback`
   - netease/qq search 扩展 + /search/all + Search.vue 分区 + Playlist.vue 复用为 album

## Testing

### 自定义头像

- 单元：DB 迁移加 `custom_avatar_path` 列幂等；上传 API 校验大小/MIME；ProfileManager.applyIdleAvatar 在 onSongChange(null) 后被调用
- 集成：mock TS3Client 验证 fileTransferInitUpload 收到的 buffer 是 customAvatar
- 手动：本地起 bot 上传一张 png → 检查头像；播一首歌 → 头像切封面；停止 → 头像回到 png；关掉 avatarEnabled 重启 → 头像直接是 png

### 专辑搜索

- 单元：netease/qq `search()` 测试：响应包含 albums 字段，长度 > 0 (mock fixture 必须含 album 段)
- 集成：`/search/all` 响应 schema 包含 `albums`/`playlists`
- 手动：搜"周杰伦" → 看到歌曲 + 专辑 + 歌单三个分区；点专辑 → 详情页 → 播放全部 → 队列加上整张专辑

## Migration

DB 迁移：`bot_instances.custom_avatar_path` TEXT NULL，默认 NULL。已存在 bot 不受影响。

## Open Questions

- TS6 协议路径下 `fileTransferInitUpload` 是否一致？（既有 avatar 流程已经覆盖 TS3 + TS6，本期沿用同一路径，不单独验证）
- 头像超过 200 KB 时前端用 Canvas 自动 resize 还是直接拒？— **决定：拒，错误提示"请压缩到 200KB 以内"**，简单可控
