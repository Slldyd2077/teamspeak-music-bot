# WebUI Authentication

**Date:** 2026-05-27
**Status:** Spec — pending implementation
**Branch:** `feat/webui-auth`

## Problem

WebUI 的所有后端端点和 WebSocket 当前没有任何鉴权：

- `src/web/server.ts` 注册的 `/api/bot`、`/api/player`、`/api/music`、`/api/auth`、`/api/config/public-url`、`/api/health`、`/ws` 均无中间件拦截。
- 静态前端通过 `express.static()` 直接对外提供。

后果：任何能访问 WebUI 端口（默认 `3000`）的人都能控制 bot、修改配置、操控播放，并触发对网易云 / QQ / Bilibili 的登录二维码流程。一旦 WebUI 端口暴露公网（无论是直接绑定 `0.0.0.0`、还是经 nginx 反代），即被任意访客接管。

## Goal

为 WebUI 增加用户名 + 密码登录，覆盖所有 HTTP `/api/*` 端点（除显式公共白名单）以及 `/ws` WebSocket，使未登录访客无法调用任何敏感接口或观察 bot 状态。

## Out of Scope（明确不做）

- 登录失败的限流 / 锁定（无 brute-force 防御；可放在反代层；后续 PR 单独做）
- 角色与权限（admin / viewer）—— 全员同权
- 密码重置流程（不挂邮件；仅提供登录后 `change-password`）
- 双因素认证（2FA）
- "记住我" / 绝对过期 vs 滑动过期的可配置
- 旧版"无鉴权"兼容开关（`requireAuth=false`）—— 合入后所有部署强制启用鉴权
- 现有 `config.adminPassword` 字段的迁移 —— 保留为未使用字段，避免破坏旧 `config.json`

## Non-functional Constraints

- 不引入需要原生编译的依赖（Windows 用户多，build tools 不稳定）。密码哈希用纯 JS 的 `bcryptjs`。
- Cookie 行为必须兼容现有 `trustProxy` 反代部署。
- 升级路径：旧用户首次启动新版本 → 自动进入 `/setup` 创建首位 admin；期间所有 `/api/*` 仍拒绝访问。期间不存在"裸奔窗口"。
- 后续维护者要能在不阅读 `requireAuth` 内部细节的情况下，把新路由挂到 `/api/*` 下并自动获得鉴权。

## Architecture

### 数据层（`src/data/`）

扩展 `src/data/database.ts` 的 schema-migration 块，新增两张表：

```sql
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,                 -- uuid v4
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  passwordHash TEXT NOT NULL,                    -- bcryptjs, 12 rounds
  createdAt    INTEGER NOT NULL,
  updatedAt    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,                  -- sha256(rawToken) hex
  userId      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  createdAt   INTEGER NOT NULL,
  expiresAt   INTEGER NOT NULL,                  -- ms epoch
  lastSeenAt  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_userId    ON sessions(userId);
CREATE INDEX IF NOT EXISTS idx_sessions_expiresAt ON sessions(expiresAt);
```

**为什么 `sessions.id` 存 sha256(token) 而不是 token 本身：** 若 SQLite 文件被泄露（备份、误传、磁盘扫描），原始 token 会让攻击者直接冒充任意已登录用户。存 hash 后只能爆破。代价仅是每次请求一次 sha256。

新模块：

`src/data/users.ts`
- `createUser(username, password): User` — 在事务里 INSERT；遇到 UNIQUE 冲突抛出 `UsernameTakenError`
- `findByUsername(username): User | null`
- `verifyPassword(plain, hash): Promise<boolean>` — bcryptjs compare
- `countUsers(): number` — 用于 `/needs-setup`
- `changePassword(userId, newPassword): void`

`src/data/sessions.ts`
- `createSession(userId): { token: string; expiresAt: number }` — 生成 32 字节随机 token（`crypto.randomBytes(32).toString('base64url')`），存 sha256
- `validateAndTouch(rawToken): { userId, username } | null` — 单次 SQL JOIN：查 session + user；过期 → 返回 null + 删除该行；否则若 `now - lastSeenAt > 1h` 则 UPDATE 滑动续期到 `now + 7d`
- `deleteSession(rawToken): void` — 退出
- `deleteAllForUser(userId, exceptToken?): void` — change-password 时调用，可保留当前会话
- `cleanupExpired(): void` — 定时任务

### HTTP 层（`src/web/`）

#### 新增中间件

`src/web/middleware/requireAuth.ts`
```
读取 req.cookies.tsmb_session
  → 缺失 → 401 { error: "unauthenticated" }
  → 调 sessions.validateAndTouch
  → null → 清 cookie + 401
  → 有效 → req.user = { id, username }; next()
```

`src/web/middleware/csrf.ts`
```
若 method ∈ {GET, HEAD, OPTIONS} → next()
否则要求 req.headers.origin || req.headers.referer 的 host 与 req.get('host') 一致
  → 不一致或两者都缺失 → 403 { error: "bad origin" }
```

#### 新路由：`src/web/api/session.ts`

挂在 `/api/session`，全部公共（不挂 requireAuth）：

| Method | Path | 行为 |
|---|---|---|
| GET | `/needs-setup` | `{ needsSetup: users.countUsers() === 0 }` |
| POST | `/setup` | Body `{ username, password }`。在事务内再次检查 `countUsers() === 0`：是则 INSERT user + 立刻 createSession + Set-Cookie + 200 `{ id, username }`；否则 409 `{ error: "already initialized" }` |
| POST | `/login` | Body `{ username, password }`。匹配则 createSession + Set-Cookie + 200；不匹配则等待 250ms 后 401 `{ error: "invalid credentials" }`（常量时间延迟，降低用户名枚举风险） |
| POST | `/logout` | 删 session，清 cookie，204 |
| GET | `/me` | 走 requireAuth；返回 `{ id, username }` |
| POST | `/change-password` | 走 requireAuth；Body `{ oldPassword, newPassword }`；通过则 changePassword + deleteAllForUser(except 当前) + 204 |

> `/me` 与 `/change-password` 例外地需要 requireAuth —— 在路由内单独挂中间件，避免污染 `/api/session/*` 的公共属性。

#### Cookie 规范

- 名称：`tsmb_session`
- 值：32 字节 random → base64url
- 属性：`HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`（7 天）
- `Secure` 标志：当 `req.secure === true`（依赖 `trustProxy` + `X-Forwarded-Proto`）；本地 HTTP 调试时不加，避免 cookie 被丢弃

#### 装配顺序（`src/web/server.ts`）

```ts
app.use(express.json({ limit: "400kb" }));
app.use(cookieParser());                              // 新增

// 公共
app.get("/api/health", …);
app.get("/api/config/public-url", …);
app.use("/api/session", createSessionRouter(...));

// 闸门（仅作用于下方注册的 /api/* 路由）
app.use("/api", csrfOriginCheck);
app.use("/api", requireAuth);

// 受保护
app.use("/api/bot",    createBotRouter(...));
app.use("/api/music",  createMusicRouter(...));
app.use("/api/player", createPlayerRouter(...));
app.use("/api/auth",   createAuthRouter(...));        // 音乐平台 QR

// 静态 SPA（公共，前端自行判定登录态后跳转）
app.use(express.static(staticDir));
app.get(/^(?!\/api|\/ws)/, sendIndex);
```

> Express 的 `app.use` 仅对匹配前缀生效。公共路由先注册即可命中；之后的 `app.use("/api", …)` 闸门只在公共路由未匹配时执行，因此 `/api/health`、`/api/config/public-url`、`/api/session/*` 不会被闸门拦截。

#### 定时清理

`server.start()` 内启动 `setInterval(cleanupExpired, 60 * 60 * 1000)`，`server.stop()` 内 `clearInterval`。

### WebSocket 层（`src/web/websocket.ts` + `src/web/server.ts`）

改造为手动 upgrade：

```ts
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") { socket.destroy(); return; }
  const session = validateCookieFromHeaders(req.headers.cookie);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    (ws as any).userId = session.userId;
    wss.emit("connection", ws, req);
  });
});
```

`validateCookieFromHeaders` 在 `src/web/auth/validateSession.ts` 提供，HTTP 中间件与 WS upgrade 共用同一实现，确保不会出现"HTTP 拒、WS 放行"或反之的偏差。

不需要在 upgrade 上单独做 CSRF：浏览器在跨站 WebSocket 请求里仍会带 Origin 头，可在 validate 之外顺手比对 `req.headers.origin` host 与 `req.headers.host` 一致；不一致直接拒绝。

### 前端层（`web/`）

#### 新视图

- `web/src/views/Login.vue` — 用户名 + 密码表单 → POST `/api/session/login` → 成功跳 `next` 或 `/`
- `web/src/views/FirstRunSetup.vue` — 同样表单 + 二次确认密码 → POST `/api/session/setup` → 成功后自动登录并跳 `/`
  - 名称避免与既有 `Setup.vue`（bot 创建向导）冲突

#### Session 状态

新增 `web/src/composables/useSession.ts`：暴露 `currentUser: Ref<User|null>`、`refresh()`、`logout()`、`needsSetup: Ref<boolean>`。在 `App.vue` mount 时调用 `refresh()`。

#### 路由守卫（`web/src/router/index.ts`）

- 公共路由：`/login`、`/setup`
- 全局 `beforeEach`：
  1. 先 `GET /api/session/needs-setup`（仅在 `needsSetup` 未知时拉一次并缓存）
  2. `needsSetup === true` 且目标不是 `/setup` → `redirect('/setup')`
  3. 否则 `GET /api/session/me`，401 且目标非公共路由 → `redirect('/login?next=<path>')`

#### API 客户端

- 所有 `fetch` 改为 `credentials: 'same-origin'`（若现有有 wrapper 则改一处；否则按文件逐个改 —— 实施时由 plan 列出）
- 包一层 401 拦截器：任意受保护请求返回 401 → 清 `currentUser` → `router.push('/login')`

#### UI

- 顶栏新增已登录用户名 + "退出"按钮（POST `/logout` → `router.push('/login')`）
- 修改密码入口暂放在已有的"设置"页签内（若无则新增极简 section）

### 依赖

新增到 `package.json`：

```
"bcryptjs": "^2.4.3",
"cookie-parser": "^1.4.6",
"@types/bcryptjs": "^2.4.6",
"@types/cookie-parser": "^1.4.7"
```

不引入 `express-session`、`jsonwebtoken`、`passport` 等更大栈。

## Data Flow

### 首次启动

```
Browser → GET /         → static SPA
SPA mounted → GET /api/session/needs-setup → { needsSetup: true }
SPA → router.replace('/setup')
User submits form → POST /api/session/setup
Server (TX): countUsers() === 0 → INSERT user → createSession → Set-Cookie → 200
SPA → currentUser refresh → router.replace('/')
```

### 已部署用户升级

旧 `config.adminPassword` 字段保留不动；首次启动新版本仍会因 `users` 表为空而进入 setup 流程 —— 旧字段不被采纳，避免歧义。

### 后续登录

```
SPA → GET /api/session/me → 401
SPA → router.replace('/login?next=/queue')
User submits → POST /api/session/login → Set-Cookie + 200
SPA → currentUser refresh → router.replace('/queue')
```

### 受保护请求

```
SPA → fetch('/api/bot', { credentials: 'same-origin' })
Server requireAuth: validateAndTouch(cookie)
  → ok → req.user 注入 → 业务路由处理
  → 不 ok → 401 → SPA 拦截器跳 /login
```

### WebSocket

```
SPA → new WebSocket(`${wsScheme}://${host}/ws`)   // 浏览器自动带 cookie
Server upgrade handler: validateCookieFromHeaders
  → ok → handleUpgrade → connection event
  → 不 ok → HTTP 401 写回原始 socket → destroy
```

## Error Handling

| 场景 | HTTP 响应 | 备注 |
|---|---|---|
| 未带 cookie | 401 `{ error: "unauthenticated" }` | requireAuth |
| Cookie 解析失败 / token 不存在 | 401 + `Set-Cookie tsmb_session=; Max-Age=0` 清掉 | 自愈 |
| Session 过期 | 同上 + DELETE 该行 | validateAndTouch 内部完成 |
| 用户名/密码不匹配 | 401 `{ error: "invalid credentials" }` + 250ms 延迟 | 不区分"用户不存在"和"密码错"两类 |
| `setup` 时已存在用户 | 409 `{ error: "already initialized" }` | 防止重复初始化 |
| `setup` 用户名重复 | 在 `/setup` 流程中不可能（只允许 0 → 1） |  |
| `change-password` 旧密码错 | 401 `{ error: "invalid credentials" }` |  |
| CSRF Origin 不匹配 | 403 `{ error: "bad origin" }` |  |
| WS 无 cookie / 校验失败 | 写回 HTTP/1.1 401 并 destroy socket | 在握手前拒绝，避免 onopen 假成功 |

所有错误响应统一 `{ error: string }` 形式，匹配现有 API 风格。

## Testing Strategy

### 单元（vitest）

`src/data/users.test.ts`
- createUser 成功后 findByUsername 命中（大小写不敏感）
- 重复 username 抛 UsernameTakenError
- verifyPassword 正反例
- changePassword 之后旧哈希不再验证通过

`src/data/sessions.test.ts`
- createSession 返回的 token 不是 DB 内 id（DB 内是 sha256(token)）
- validateAndTouch 过期记录返回 null 且记录被删
- validateAndTouch 未过 1h 不写 DB；过 1h 后写 DB（用 `Date.now` mock 验证）
- deleteAllForUser(exceptToken) 保留指定会话

### 集成（vitest + supertest，真 SQLite in-memory）

`src/web/api/session.test.ts`
- empty DB → /needs-setup 返回 true；/setup 成功；/needs-setup 再调返回 false；二次 /setup 返回 409
- /login 成功后受保护路由 (`GET /api/bot`) 200；不带 cookie 401
- /logout 之后同一 cookie 调受保护路由 401
- /change-password 后 a) 旧密码 /login 失败 b) 新密码 /login 成功 c) 之前签发的其他 cookie 失效，当前 cookie 仍可用

`src/web/middleware/csrf.test.ts`
- 带匹配 Origin 的 POST 通过
- Origin 与 host 不匹配 → 403
- 同样规则适用 Referer
- GET 永远通过

`src/web/websocket.test.ts`（新增或扩展）
- 无 cookie 的 ws 握手 → 收到 HTTP 401，socket 关闭
- 带有效 cookie → 握手成功，收到 init 消息
- Session 删除后已建立的 ws **不会**被主动断（明确记录此妥协 —— 见 Trade-offs）

### 前端

不在本 PR 引入新的 e2e 框架。手动用例（在 PR 描述里列）：
- 全新数据库启动 → 自动跳 /setup → 创建账户 → 进入主界面
- 退出 → 自动跳 /login
- 关闭浏览器 7 天内再开 → 仍登录
- 登录态下后端重启清空 sessions → 任意 API 调用 → 自动跳 /login

## Files Changed

```
src/data/database.ts                       (schema migration)
src/data/users.ts                          (new)
src/data/users.test.ts                     (new)
src/data/sessions.ts                       (new)
src/data/sessions.test.ts                  (new)
src/web/auth/validateSession.ts            (new, shared by HTTP + WS)
src/web/middleware/requireAuth.ts          (new)
src/web/middleware/csrf.ts                 (new)
src/web/middleware/csrf.test.ts            (new)
src/web/api/session.ts                     (new)
src/web/api/session.test.ts                (new)
src/web/server.ts                          (cookieParser + 公共白名单 + 闸门 + cleanup interval + WS upgrade 重构调用)
src/web/websocket.ts                       (移除被动 path 绑定；改为 handleUpgrade 模式)
src/web/websocket.test.ts                  (新增 / 扩展)
package.json                               (deps)

web/src/views/Login.vue                    (new)
web/src/views/FirstRunSetup.vue            (new)
web/src/composables/useSession.ts          (new)
web/src/router/index.ts                    (公共路由 + beforeEach 守卫)
web/src/api/*.ts                           (credentials: 'same-origin' + 401 拦截)
web/src/App.vue                            (顶栏 logout + 当前用户名)
```

## Trade-offs / 已知妥协

1. **会话失效不主动断 WS** —— 后台 deleteSession 后，已有 WS 仍在跑（直到客户端断或服务端进程重启）。原因：WS 长连接没有"每条消息再次鉴权"的廉价手段；为此引入会浪费时间。影响面有限：WS 只推状态、不接收 mutating 命令；所有写操作仍走 HTTP。
2. **无登录限流** —— 见 Out of Scope。若部署面向公网，建议在反代层加 limit（如 nginx `limit_req`）。
3. **`config.adminPassword` 留作未使用字段** —— 不迁移、不读取。后续 PR 可移除并加 schema migration。当前保留是为避免破坏旧 `config.json` 解析。
4. **单一管理员模型** —— 多用户表已存在，但 UI 当前不暴露增删用户。下一个 PR 再加用户管理界面。
5. **Origin/Referer CSRF 检查** —— 不是 token，但配合 `SameSite=Lax` 已能挡掉常规 CSRF 攻击。代价：会拒绝缺 Origin/Referer 的非浏览器客户端 POST 请求（如裸 curl）—— 这是预期行为。
