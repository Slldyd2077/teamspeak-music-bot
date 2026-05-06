# Multi-Source Tabs for Recommend / User Playlists / Daily Songs

**Date:** 2026-05-06
**Status:** Spec — pending implementation

## Problem

Home 和 Library 页面的"推荐歌单 / 每日推荐 / 我的歌单"这三类内容当前硬编码只走网易云。当用户同时登录了网易云和 QQ 音乐时，无法在 Web UI 上看到 QQ 侧的对应内容、也无法切换查看。

## Goal

在以下 4 个 section 上提供"网易云 / QQ"来源切换 tab，桌面端和移动端均可用：

- `Home.vue` — 推荐歌单
- `Home.vue` — 每日推荐
- `Home.vue` — 我的歌单
- `Library.vue` — 我的歌单

切换为纯前端动作（数据已预先 fetch），无加载闪烁。各 section 的选择独立持久化。

## Out of Scope

- 私人 FM（QQ 无对应概念）
- B 站热门（独立第三来源，不属于网易/QQ 切换语义）
- 最近播放（bot 维度的播放历史，与音乐源无关）
- Library 现有的"我的收藏"段落 —— 当前调用的 `/api/music/user/liked` 端点不存在，是死代码，本次顺手移除
- 登录状态实时同步（用户在 Settings 登录后需手动刷新 Home/Library 才能看到 QQ tab）
- Tab 排序、隐藏、拖动等高级配置

## Non-functional Constraints

- 桌面端（>768px）和移动端（≤768px）布局均可用，tab 与 section title 同行排布；空间不足时允许 flex-wrap
- Tab 触控区域有效高度 ≥36px
- 现有 5 分钟 home data cache 行为保留
- 不引入新的后端端点（后端已通过 `?platform=` 参数支持多源）

## Architecture

### 数据层（`web/src/stores/player.ts`）

字段从单平台改为按 platform 切分：

```ts
// 前
recommendPlaylists: PlaylistItem[]
userPlaylists:      PlaylistItem[]
dailySongs:         Song[]

// 后
recommendPlaylists: { netease: PlaylistItem[]; qq: PlaylistItem[] }
userPlaylists:      { netease: PlaylistItem[]; qq: PlaylistItem[] }
dailySongs:         { netease: Song[];         qq: Song[] }

// 新增
authStatus: { netease: boolean; qq: boolean }
```

`fetchHomeData()` 改写：

1. 并发调用 `/api/auth/status?platform=netease` 与 `?platform=qq`，写入 `authStatus`
2. 网易云的三类数据照常 fetch（推荐歌单匿名可访问；每日推荐和我的歌单需登录，未登录时 API 自然返回空或失败，`Promise.allSettled` 已隔离）
3. QQ 的三类数据**仅在 QQ 登录时** fetch，未登录则为空数组
4. B 站热门保持原样
5. 5 分钟缓存 TTL 不变

### UI 组件

新增 `web/src/components/SourceTabs.vue`：

```vue
<SourceTabs v-model="activeSource" :sources="availableSources" />
```

Props：
- `sources: ('netease' | 'qq')[]` — 由父组件根据 auth 状态过滤后传入
- `modelValue: 'netease' | 'qq'` — v-model 绑定

行为：
- `sources.length < 2` 时组件**自身不渲染**（返回空），父组件无需 v-if 包装
- 文字标签：`{ netease: '网易云', qq: 'QQ' }`
- 视觉：水平排列，激活态用主色（`var(--color-primary)`）下划线 + 加粗，未激活态使用次要文字色
- 紧贴 section-title 右侧，使用 `display: inline-flex`，移动端 padding/font-size 缩小

### 各 section 接入模板

```vue
<section v-if="recommendAvailable.length > 0" class="section">
  <h2 class="section-title">
    推荐歌单
    <SourceTabs v-model="recommendSource" :sources="recommendAvailable" />
  </h2>
  <div class="playlist-grid">
    <RouterLink
      v-for="pl in store.recommendPlaylists[recommendSource]"
      :key="pl.id"
      :to="`/playlist/${pl.id}?platform=${pl.platform}`"
      class="playlist-card hover-scale"
    >
      <CoverArt :url="pl.coverUrl" :size="160" :radius="10" :show-shadow="true" />
      <div class="playlist-name">{{ pl.name }}</div>
    </RouterLink>
  </div>
</section>
```

每个 section 在 `<script setup>` 维护两个值：

- `recommendSource: Ref<'netease' | 'qq'>` — 当前选中
- `recommendAvailable: ComputedRef<('netease' | 'qq')[]>` — 该 section 在当前登录状态下有哪些 source 可选

`recommendAvailable` 计算规则：

| Section | netease 加入条件 | qq 加入条件 |
|---|---|---|
| Home 推荐歌单 | 总是（公开数据） | `authStatus.qq` |
| Home 每日推荐 | `authStatus.netease` | `authStatus.qq` |
| Home 我的歌单 | `authStatus.netease` | `authStatus.qq` |
| Library 我的歌单 | `authStatus.netease` | `authStatus.qq` |

#### "我的歌单"展开按钮兼容

Home 的"我的歌单"现有 `USER_PLAYLIST_LIMIT = 20` 折叠/展开。改造后：

```ts
const visibleUserPlaylists = computed(() => {
  const all = store.userPlaylists[userSource.value] ?? [];
  return userPlaylistsExpanded.value ? all : all.slice(0, USER_PLAYLIST_LIMIT);
});
```

切换 source 时折叠态保留（不需 reset）。

### 持久化

localStorage 键统一为一个 JSON：

```
key:   "source-tabs"
value: {
  "home.recommend": "qq",
  "home.daily":     "netease",
  "home.user":      "qq",
  "library.user":   "netease"
}
```

读：组件 mount 时一次性读 + 解析。
写：在 v-model 的 setter 里 `watch` 一次写回。
不存在的键 / 解析失败 / 老用户没这个 key —— 默认值 `"netease"`。

### 边界与回退

| 情况 | 行为 |
|---|---|
| 选的 source 不在 `available` 里（例：选了 QQ，登出后回到页面） | 渲染时 fallback 到 `available[0]`，不修改 localStorage（保留用户偏好，下次登回来仍生效） |
| `recommendPlaylists.qq` 为空数组（API 失败 or 无数据） | tab 仍可切，切过去显示空 grid（无错误提示，符合现有"空数据隐藏 section"语义；section 顶层 v-if 检查的是 `available.length > 0`，单 platform 数据为空不影响 section 显隐） |
| QQ provider 不支持 `getDailyRecommendSongs`（501） | `Promise.allSettled` 已捕获，`dailySongs.qq` 保持 `[]`，等同上一行 |
| 用户在 Settings 登录 QQ 后切回 Home | 不自动 refetch / 不自动出 tab —— 用户需手动刷新页面（保留 5 分钟缓存语义） |
| 网易云和 QQ 都没登录 | `available` 为空时 section 隐藏（沿用现有逻辑） |
| Library "我的收藏" 段落 | 整段移除（含 template、script 中的 `liked` ref、对应 axios 调用） |

## 修改文件清单

新增：
- `web/src/components/SourceTabs.vue` — 共享 tab 组件

修改：
- `web/src/stores/player.ts` — 多平台 state、`authStatus`、`fetchHomeData` 重写
- `web/src/views/Home.vue` — 三个 section 接入 SourceTabs，对应 ref + computed
- `web/src/views/Library.vue` — 我的歌单接入 SourceTabs；移除我的收藏死代码

不改：
- 后端（API 已支持 `?platform=`）
- `Search.vue` / `Playlist.vue` / `Settings.vue` 等其他页面

## 测试方案

- 手动：在两种登录组合下访问 Home 和 Library，验证 tab 显隐、切换、刷新后持久化
  - 仅网易登录 → 不显示 tab
  - 两边登录 → 显示 tab，切换后刷新页面来源不变
  - QQ 登录 → 网易登出 → 网易 tab 消失，若上次选的是网易则 fallback 到 QQ
- 移动端（DevTools 768px 以下）：tab 与 section-title 同行不溢出，触控区域可点
- TypeScript 类型检查通过：`npx tsc --noEmit` + `npm run build:web`
- 单元测试：现有 vitest 套件不应回归（store 改动不破坏其他用法）

## 风险

- store 字段类型变更（数组 → 对象）会影响所有读取这三个字段的地方。需 grep 确认没有遗漏的消费者。
- localStorage 解析失败的容错必须周全，避免一次脏数据导致整个页面白屏。
