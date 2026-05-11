<p align="center">
  <img src="https://img.shields.io/badge/TeamSpeak-音乐机器人-blue?style=for-the-badge&logo=teamspeak" alt="TSMusicBot" />
</p>

<h1 align="center">TSMusicBot</h1>

<p align="center">
  <strong>TeamSpeak 音乐机器人</strong> — 网易云音乐 + QQ 音乐 + 哔哩哔哩 + YouTube（可选），YesPlayMusic 风格 WebUI 控制面板
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/许可证-MIT-green" />
  <img src="https://img.shields.io/badge/FFmpeg-已内置-orange?logo=ffmpeg" />
  <img src="https://img.shields.io/badge/Docker-支持-2496ED?logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/BiliBili-支持-00a1d6?logo=bilibili&logoColor=white" />
  <img src="https://img.shields.io/badge/YouTube-可选-FF0000?logo=youtube&logoColor=white" />
  <img src="https://img.shields.io/badge/TS3-支持-2580C3?logo=teamspeak&logoColor=white" />
  <img src="https://img.shields.io/badge/TS6-支持-2580C3?logo=teamspeak&logoColor=white" />
</p>

## 功能特性

- **多平台音源** — 网易云音乐 + QQ 音乐 + 哔哩哔哩（默认内置），YouTube 可选启用（通过 yt-dlp），统一搜索，结果标注来源
- **真实客户端协议 (TS3/TS6 双协议)** — 机器人在 TeamSpeak 中可见（非 ServerQuery 隐身模式），自动检测并适配 TS3 和 TS6 服务器，支持 TS6 HTTP Query API
- **YesPlayMusic 风格 WebUI** — 精美界面，支持深色/浅色主题切换
- **完整播放控制** — 播放/暂停/上一首/下一首/进度跳转/音量调节
- **四种播放模式** — 顺序播放/循环播放/随机播放/随机循环
- **实时歌词同步** — 歌词滚动显示，支持翻译歌词，服务端帧计数精确同步
- **歌单管理** — 推荐歌单/我的歌单/每日推荐/私人FM，点击播放全部
- **音质选择** — 标准(128k) / 较高(192k) / 极高(320k) / 无损(FLAC) / Hi-Res / 超清母带
- **B站视频音频提取** — 搜索B站视频，自动提取DASH最高码率音频流播放
- **B站热门推荐** — 首页展示B站热门视频和个性化推荐（登录后更准确）
- **QR码登录** — 扫码登录网易云/QQ音乐/哔哩哔哩账号，Cookie 自动持久化
- **机器人形象自动更新** — 播放时自动更新头像（专辑封面）、昵称（当前歌曲）、描述、Away 状态、频道描述，停止时恢复默认值。每项功能独立可配置，权限不足时自动降级
- **多机器人独立播放** — 多个机器人同时在不同服务器或频道播放不同音乐，每个机器人独立的播放队列、进度和音量，WebUI 一键切换控制
- **播放历史** — 自动记录所有播放过的歌曲
- **懒加载机制** — 歌单只存储元数据，播放时才获取链接（避免链接过期）
- **一键部署** — FFmpeg 内置，Windows 双击运行 / Linux systemd / Docker

## 截图

> <img width="2568" height="1408" alt="musicbot1" src="https://github.com/user-attachments/assets/47ba4f62-fae3-4c17-a7f7-b53f00885672" />
> <img width="2568" height="1408" alt="musicbot2" src="https://github.com/user-attachments/assets/42f4bef7-d41b-49e3-8c13-b4ce6c822dba" />

## 快速开始

### 方式一：Windows 一键部署（最简单）

只需电脑有网络连接，其他一切自动安装。

```
1. 下载或 clone 本项目
2. 双击 scripts\setup.bat      （首次安装，自动安装 Node.js 和所有依赖）
3. 双击 scripts\start.bat      （启动机器人）
4. 浏览器打开 http://localhost:3000
```

> `setup.bat` 会自动通过 winget 安装 Node.js（如果未安装），运行 `npm install` 安装所有依赖（包括内置 FFmpeg），最后构建项目。之后每次只需双击 `start.bat` 启动。

### 方式二：手动安装（所有系统）

**前置条件：** [Node.js 20+](https://nodejs.org/) 和一个 TeamSpeak 服务器（TS3/TS5/TS6 均可）。
FFmpeg **已自动内置**，无需手动安装。

```bash
# 下载项目
git clone https://github.com/ZHANGTIANYAO1/teamspeak-music-bot.git
cd teamspeak-music-bot

# 安装依赖
npm install
cd web && npm install && cd ..

# 构建
npm run build

# 启动
npm start
```

打开浏览器访问 **http://localhost:3000**，按照设置向导完成配置。

### 方式三：Docker 一键部署

所有依赖已内置（Node.js、FFmpeg、Opus 编码器），无需安装任何额外软件。

```bash
git clone https://github.com/ZHANGTIANYAO1/teamspeak-music-bot.git
cd teamspeak-music-bot/scripts/docker
docker-compose up -d
```

打开浏览器访问 **http://localhost:3000**

<details>
<summary>Docker 详细说明</summary>

- 首次构建需要几分钟（编译原生模块）
- 默认使用 `host` 网络模式，机器人可直接连接局域网 TS3 服务器
- 数据持久化在 Docker 命名卷 `tsmusicbot-data` 中（数据库、Cookie、日志）
- 内置健康检查（`/api/health`），支持 Docker 自动重启

```bash
docker logs -f tsmusicbot          # 查看日志
docker-compose down                # 停止
docker-compose up -d --build       # 代码更新后重新构建
```

如果 TS3 服务器在其他机器上，编辑 `docker-compose.yml`：
```yaml
# 将 network_mode: host 替换为：
ports:
  - "3000:3000"
```

</details>

### 方式四：Linux 一键安装

```bash
chmod +x scripts/install.sh
sudo ./scripts/install.sh
```

自动安装 Node.js 和依赖，配置 systemd 服务，支持开机自启。

## 更新升级

> **⚠️ 从使用 `@honeybbq/teamspeak-client 0.1.x` 的旧版本升级时的重要变更**
>
> 本项目已将底层 TeamSpeak 协议库升级到 `0.2.x` 并移除了内置的 TS6 兼容层，改用库自带的通用 `clientinit` 协议。这涉及一次**数据库迁移**：
>
> **旧的身份（identity）不兼容新的加密握手路径。** `0.1.0` 版本的库在生成 TS 客户端身份时存在 P-256 公钥 DER 编码错误，该 bug 在 `0.1.1` 中由本项目维护者 [ZHANGTIANYAO1](https://github.com/HoneyBBQ/teamspeak-js/pull/5) 修复并合并到上游。`0.1.0` 生成的身份与 `0.2.x` 修复后的握手路径**不兼容**：升级后用旧身份连接会卡在 `received initivexpand2` 直到 15 秒超时。
>
> **解决办法**：升级后清空受影响机器人的 `identity` 字段，下次启动时程序会自动生成新身份并持久化。
>
> ```bash
> # 对每个需要迁移的机器人执行（替换 <bot-id> 为实际 UUID）：
> python -c "import sqlite3; db=sqlite3.connect('data/tsmusicbot.db'); \
>   db.execute(\"UPDATE bot_instances SET identity=NULL WHERE id='<bot-id>'\"); \
>   db.commit()"
>
> # 或者清空所有机器人的身份：
> python -c "import sqlite3; db=sqlite3.connect('data/tsmusicbot.db'); \
>   db.execute('UPDATE bot_instances SET identity=NULL'); db.commit()"
> ```
>
> **影响范围**：
> - ✅ TS3 服务器 + 旧身份：在多数情况下仍可正常工作（TS3 对 legacy 编码更宽容），可选择不清空
> - ❌ TS6 服务器 + 旧身份：**必须**清空身份才能连接
> - ⚠️ 清空身份后，TS 服务器会把机器人识别为**全新的客户端**。之前手动赋予机器人的**服务器组需要用新 UID 重新授予一次**，之后每次重启都会自动保留
>
> **如何判断是否需要迁移**：如果你是全新安装，或者你的机器人数据库中 `identity` 字段已经是空的，则**无需任何操作**。完成上述步骤后，按下面对应的系统升级步骤执行即可。

### Windows 用户

```
1. 双击 scripts\stop.bat 停止运行中的机器人（或手动关闭窗口）
2. 在项目目录打开命令行，执行 git pull
3. 双击 scripts\setup.bat 重新安装依赖并构建
4. 双击 scripts\start.bat 启动
```

### 手动安装用户（所有系统）

```bash
# 停止当前运行的机器人（Ctrl+C 或 kill 进程）

# 拉取最新代码
git pull

# 重新安装依赖（如有新增依赖）
npm install
cd web && npm install && cd ..

# 重新构建
npm run build

# 启动
npm start
```

### Docker 用户

```bash
cd scripts/docker

# 拉取最新代码
git pull

# 重新构建并启动（数据自动保留）
docker-compose up -d --build
```

> 数据（数据库、Cookie、日志）保存在 Docker 命名卷 `tsmusicbot-data` 中，更新不会丢失。

### Linux systemd 用户

```bash
# 停止服务
sudo systemctl stop tsmusicbot

# 拉取最新代码
git pull

# 重新安装依赖并构建
npm install
cd web && npm install && cd ..
npm run build

# 重新启动服务
sudo systemctl start tsmusicbot
```

> **提示：** 更新不会影响你的 `config.json` 配置文件、数据库和登录 Cookie，所有数据会自动保留。但请注意本节开头关于 **身份迁移** 的警告——从 0.1.x 版本升级时需要手动清空旧身份。

## 使用说明

### 首次配置

1. 打开 **http://localhost:3000/setup** 进入设置向导
2. 填写 TeamSpeak 服务器地址（默认端口：9987）
3. 设置机器人昵称
4. （可选）扫码登录网易云/QQ音乐账号以播放 VIP 歌曲

### WebUI 页面说明

| 页面 | 功能 |
|------|------|
| **首页** | 推荐歌单、每日推荐、私人FM、我的歌单 |
| **搜索** | 三平台统一搜索，结果标注网易云/QQ/B站来源 |
| **歌单** | 查看歌单详情，播放全部（根据当前播放模式选择首歌） |
| **歌词** | 全屏歌词页，实时同步滚动，模糊专辑封面背景 |
| **历史** | 播放历史记录 |
| **设置** | 主题切换、机器人管理、三平台账号登录、音质选择、命令前缀 |

### TeamSpeak 文字命令

在 TeamSpeak 频道中发送文字消息控制机器人：

| 命令 | 说明 |
|------|------|
| `!play <歌名>` | 搜索并播放 |
| `!play -q <歌名>` | 从 QQ 音乐搜索 |
| `!play -b <关键词>` | 从哔哩哔哩搜索视频并播放音频 |
| `!play -y <关键词>` | 从 YouTube 搜索并播放（需要安装 [yt-dlp](#可选youtube-音源)）|
| `!add <歌名>` | 添加到播放队列 |
| `!pause` / `!resume` | 暂停 / 恢复播放 |
| `!next` / `!prev` | 下一首 / 上一首 |
| `!stop` | 停止播放并清空队列 |
| `!vol <0-100>` | 设置音量 |
| `!queue` | 查看播放队列 |
| `!mode <seq\|loop\|random\|rloop>` | 切换播放模式 |
| `!playlist <歌单名或ID>` | 加载歌单（支持名称模糊搜索和 ID） |
| `!playlist -q <歌单名>` | 从 QQ 音乐搜索并加载歌单 |
| `!album <ID>` | 加载专辑 |
| `!artist <歌手名>` | 按歌手循环播放（支持 `-q`/`-b`/`-y`） |
| `!fm` | 私人 FM（网易云，自动续播） |
| `!lyrics` | 显示当前歌词 |
| `!now` | 当前播放信息 |
| `!vote` | 投票跳过当前歌曲 |
| `!move <频道名>` | 移动到指定频道 |
| `!help` | 显示帮助信息 |

> 命令前缀默认为 `!`，可在设置页面修改。支持别名：`!p` = `!play`，`!s` = `!skip`，`!n` = `!next`

### 音质等级

| 等级 | 码率 | 格式 | 说明 |
|------|------|------|------|
| 标准 | 128kbps | MP3 | 免费可用 |
| 较高 | 192kbps | MP3 | 免费可用 |
| **极高** | **320kbps** | **MP3** | **默认选择** |
| 无损 | ~900kbps | FLAC | 需要 VIP |
| Hi-Res | ~1500kbps | FLAC | 需要 VIP |
| 超清母带 | ~4000kbps | FLAC | 需要黑胶 VIP |

在设置页面选择音质，立即生效（影响后续播放的歌曲）。

## 项目架构

```
teamspeak-music-bot/
├── src/                        # 后端源码 (TypeScript)
│   ├── audio/                  # 音频管线：FFmpeg → PCM → Opus → 20ms 帧
│   │   ├── encoder.ts          # Opus 编码器 (@discordjs/opus)
│   │   ├── player.ts           # FFmpeg 播放器（内置 ffmpeg-static，帧计数进度追踪）
│   │   └── queue.ts            # 播放队列（4种模式，懒加载URL）
│   ├── bot/                    # 机器人核心
│   │   ├── commands.ts         # 文字命令解析器（前缀、别名、权限）
│   │   ├── instance.ts         # Bot 实例（绑定 TS3 + 播放器 + 音源）
│   │   ├── manager.ts          # 多实例生命周期管理
│   │   └── profile.ts          # 机器人形象管理（头像/昵称/描述/Away/频道描述）
│   ├── data/                   # 数据层
│   │   ├── config.ts           # JSON 配置文件
│   │   └── database.ts         # SQLite 数据库（播放历史、实例持久化）
│   ├── music/                  # 音源服务
│   │   ├── provider.ts         # 统一 MusicProvider 接口
│   │   ├── netease.ts          # 网易云音乐适配器
│   │   ├── qq.ts               # QQ 音乐适配器
│   │   ├── bilibili.ts         # 哔哩哔哩适配器（视频音频提取）
│   │   ├── youtube.ts          # YouTube 适配器（可选，依赖 yt-dlp）
│   │   ├── auth.ts             # Cookie 持久化存储
│   │   └── api-server.ts       # 嵌入式 API 服务（自动启动）
│   ├── ts-protocol/            # TeamSpeak 客户端协议（TS3/TS6 双协议）
│   │   ├── client.ts           # 完整客户端（ECDH + AES-EAX 加密协议）
│   │   ├── protocol-detect.ts  # 服务器协议自动检测（TS3 vs TS6）
│   │   ├── http-query.ts       # TS6 HTTP Query 客户端（替代 TS3 ServerQuery）
│   │   └── ts6-compat.ts       # TS6 兼容中间件（版本升级 + 签名）
│   ├── web/                    # Web 后端
│   │   ├── server.ts           # Express + WebSocket 服务
│   │   ├── websocket.ts        # 实时状态广播
│   │   └── api/                # REST API 路由
│   │       ├── bot.ts          # 机器人管理 CRUD
│   │       ├── music.ts        # 搜索/歌单/歌词/音质
│   │       ├── player.ts       # 播放控制/队列/历史/跳转
│   │       └── auth.ts         # QR登录/Cookie/SMS
│   └── index.ts                # 入口（启动所有服务）
├── web/src/                    # 前端源码 (Vue 3)
│   ├── components/             # Player, Navbar, Queue, CoverArt, SongCard
│   ├── views/                  # Home, Search, Playlist, Lyrics, History, Settings, Setup
│   ├── stores/                 # Pinia 状态管理（含服务端时间同步）
│   ├── composables/            # WebSocket 自动重连
│   └── styles/                 # SCSS 主题变量（深色/浅色）
├── scripts/                    # 部署脚本
│   ├── setup.bat               # Windows 首次安装
│   ├── start.bat               # Windows 启动脚本
│   ├── install.sh              # Linux 一键安装 + systemd 服务
│   └── docker/                 # Docker 部署文件
│       ├── Dockerfile
│       └── docker-compose.yml
├── data/                       # 运行时数据（自动创建，不上传）
│   ├── tsmusicbot.db           # SQLite 数据库
│   ├── cookies/                # 登录 Cookie
│   └── logs/                   # 日志文件
└── config.json                 # 配置文件（首次运行自动生成，不上传）
```

## 技术栈

| 层级 | 技术 |
|------|------|
| **运行时** | Node.js 20+, TypeScript 5 |
| **后端框架** | Express 4, WebSocket (ws) |
| **数据库** | better-sqlite3 (SQLite) |
| **音频处理** | FFmpeg (ffmpeg-static 内置), @discordjs/opus |
| **TS 协议** | @honeybbq/teamspeak-client（完整客户端协议）+ 自研 TS6 协议适配层 |
| **网易云 API** | NeteaseCloudMusicApi |
| **QQ 音乐 API** | @sansenjian/qq-music-api |
| **哔哩哔哩** | BiliBili Web API（搜索、DASH 音频流、QR 登录） |
| **前端框架** | Vue 3, Vite 5, Pinia, Vue Router 4 |
| **界面样式** | SCSS（YesPlayMusic 设计风格） |
| **图标** | @iconify/vue |
| **日志** | pino |

## 可选：YouTube 音源

YouTube 是**可选**的音源，默认**未启用**，需要安装 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 才能使用。启用后可通过聊天命令 `!play -y <关键词>` 或 WebUI 的 YouTube 平台选项搜索/播放 YouTube 视频的音频流。

### 启用方式（任选其一）

**方式一：项目本地 `bin/` 目录（推荐）**

将 `yt-dlp` 可执行文件放到项目根目录下的 `bin/` 文件夹，程序会优先使用此路径。该目录已被 `.gitignore` 忽略，不会影响代码更新。

```bash
# Windows（PowerShell 或 Git Bash）
mkdir bin
curl -L -o bin/yt-dlp.exe https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe

# Linux / macOS
mkdir -p bin
curl -L -o bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
chmod +x bin/yt-dlp
```

**方式二：系统级安装（让 `yt-dlp` 在 `PATH` 中可用）**

```bash
# Windows
winget install yt-dlp

# macOS
brew install yt-dlp

# Debian/Ubuntu
sudo apt install yt-dlp

# 通用（Python 环境下）
pip install -U yt-dlp
```

### 验证是否可用

重启机器人程序，在 WebUI 或 `!play -y lofi` 测试搜索。若 `bin/` 和 `PATH` 中都找不到 `yt-dlp`，YouTube 搜索会静默返回空结果（不会影响其他音源），其余功能正常。

### 注意事项

- YouTube 音源通过 `yt-dlp` 本地调用实现，不依赖 API Key，也无需登录
- 播放的是视频的最佳音频流（`bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio`），由 FFmpeg 解码
- 音质由源视频决定，不受音质设置影响
- 受 YouTube 风控/地域限制，部分视频可能无法播放
- `yt-dlp` 更新较频繁，如果播放失败，先尝试升级 `yt-dlp` 到最新版本

## 配置文件

`config.json` 在首次运行时自动生成，可手动编辑：

```json
{
  "webPort": 3000,
  "locale": "zh",
  "theme": "dark",
  "commandPrefix": "!",
  "commandAliases": { "p": "play", "s": "skip", "n": "next" },
  "neteaseApiPort": 3001,
  "qqMusicApiPort": 3200,
  "adminPassword": "",
  "adminGroups": [],
  "autoReturnDelay": 300,
  "autoPauseOnEmpty": true
}
```

## 常见问题

**Q：支持 TeamSpeak 6 Server 吗？**
A：支持。本项目内置 TS3/TS6 双协议支持，连接时会自动检测服务器类型。如果自动检测失败（例如 Query 端口被防火墙屏蔽），可以在创建机器人时手动指定 `serverProtocol: "ts6"`。TS6 Server 的 HTTP Query API（端口 10080）也已适配，需要时可配置 `ts6ApiKey`。

**Q：机器人连接了但 TeamSpeak 中听不到音乐？**
A：确保机器人和你在同一个频道。检查音量（`!vol 75`）。部分 VIP 歌曲需要先登录账号。

**Q：提示"无法获取播放链接"？**
A：在设置页面扫码登录音乐账号。许多歌曲需要登录后才能播放。

**Q：如何更换机器人所在频道？**
A：使用 `!move <频道名>` 命令，或在设置页面创建机器人时指定默认频道。

**Q：可以同时运行多个机器人吗？**
A：可以。在设置页面创建多个实例，分别连接不同的 TS 服务器或频道。

**Q：端口 3200 被占用？**
A：QQ 音乐 API 启动时自动监听 3200 端口。如果之前的进程还在运行，程序会自动复用。如需重启可手动结束 `node` 进程。

**Q：播放歌曲时报 FFmpeg EACCES 错误？**
A：`ffmpeg-static` 内置的 FFmpeg 二进制文件缺少执行权限。程序已自动尝试修复，如果仍然失败，请手动执行：
```bash
chmod +x node_modules/ffmpeg-static/ffmpeg
```
或者确保系统已安装 FFmpeg（`apt install ffmpeg` / `brew install ffmpeg`），程序会自动回退使用系统版本。

**Q：Docker 构建失败？**
A：原生模块（opus、sqlite3）需要编译工具，Dockerfile 已包含。确保 Docker 有足够内存（建议 2GB+）。

**Q：B站视频搜索不到结果？**
A：B站搜索需要 buvid3 匿名 Cookie（程序启动时自动获取）。如果失败，重启程序即可。登录B站账号后搜索效果更好。

**Q：YouTube 平台搜索返回空结果？**
A：YouTube 是可选音源，需要手动安装 `yt-dlp`。详见 [可选：YouTube 音源](#可选youtube-音源) 章节。快速验证：在项目根目录执行 `bin/yt-dlp --version`（或系统 `yt-dlp --version`），能打印版本号即可。若 yt-dlp 已安装但仍搜索失败，通常是网络/地域问题或 yt-dlp 版本过旧（执行 `yt-dlp -U` 升级）。

**Q：如何更新到新版本？**
A：`git pull` 拉取最新代码，然后 `npm install && npm run build && npm start` 重新构建启动。Docker 用户执行 `docker-compose up -d --build`。

## 参与贡献

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/新功能`)
3. 提交更改 (`git commit -m 'feat: 添加新功能'`)
4. 推送分支 (`git push origin feature/新功能`)
5. 提交 Pull Request

## 更新日志

> 完整历史请查看 [git log](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot/commits/main) 或 [Releases](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot/releases)。这里只列出重要变更和面向用户的破坏性改动。

### 最新版本

**机器人形象自动更新（Bot Profile）**

- **播放时自动更新 TS 形象**：头像（专辑封面缩略图）、昵称（`♪ 歌名 - 歌手 - 原昵称`）、描述（歌曲信息）、Away 状态、频道描述、"正在播放"频道消息，全部随歌曲切换自动更新。
- **停止播放时恢复默认**：头像清除、昵称恢复、Away 显示"等待播放"、描述和频道描述清空。
- **权限安全**：每项功能独立检测权限，权限不足时自动禁用该功能（不影响其他功能和播放），重连后重试。
- **独立可配置**：6 项功能可通过 REST API（`GET/PUT /api/player/:botId/profile`）独立开关，配置持久化到数据库。
- **竞争条件防护**：generation 计数器防止快速切歌时旧头像覆盖新头像；UTF-8 字节长度截断中文昵称；文件传输操作带超时保护。
- **TS3 适配**：描述通过 `clientedit`（非 `clientupdate`）设置，需要 `b_client_modify_description` 权限；昵称和 Away 通过合并的单条 `clientupdate` 避免命令队列超时。

**新命令 & FM 修复**

- **新增 `!artist <歌手名>` 命令**：搜索指定歌手的歌曲并循环播放，支持 `-q`（QQ 音乐）/ `-b`（B站）/ `-y`（YouTube）平台切换。一次加载最多 50 首，自动按歌手名过滤并设为 Loop 模式。
- **歌单模糊搜索**：`!playlist` 现在支持歌单名称模糊搜索（如 `!playlist 华语经典`），自动匹配公开歌单 + 个人歌单（网易云 + QQ）。纯数字 ID 和 URL 解析保持兼容。
- **修复 `!fm` 播放中断**：私人 FM 几首歌后静音的 bug 已修复。新增自动续播机制（队列低位自动拉取新歌），播放器健康帧追踪防止临时 URL 失败导致永久静音。
- **QQ 音乐个人歌单**：QQ Music provider 新增 `getUserPlaylists` 支持，登录后可通过 `!playlist -q <名称>` 模糊搜索个人歌单。

**协议层 & 稳定性**

- **升级 `@honeybbq/teamspeak-client` 到 `0.2.1`**，移除内置 TS6 兼容层（`ts6-compat.ts`），改用库自带的通用 `clientinit` 协议（`3.?.? [Build: 5680278000]`），TS3/TS6 单一代码路径。
  - ⚠️ **破坏性**：`0.1.0` 生成的旧身份与新握手路径不兼容，升级时需要迁移。详见 [更新升级](#更新升级) 章节顶部的警告。
- **修复 `startBot` 与 `stopBot` 之间的竞态**：mid-handshake 被替换的 BotInstance 不再泄漏 TS 会话，`disconnect()` 被 `connect()` 的 await 插队时不再错误地把 `connected` 翻回 `true`。
- **修复播放条自动刷新 bug**：BotManager 现在在创建新 BotInstance 时 emit `botInstance` 事件，WebSocket 监听器会立即重新挂接到新实例，播放状态变化无需手动刷新页面。
- **`connect()` 增加 15 秒超时**：握手卡住时会清理掉挂起的实例并返回 500，不再无限阻塞 HTTP 请求和 UI。
- **识别持久化修复**：`startBot` 现在会从数据库读取 `identity` 传给新 BotInstance，服务器组在机器人重启后能保留。

**HTTP API 加固**

- 新增输入校验，拒绝无效值并返回 **400**（之前会返回 200 包装 usage-text 字符串）：
  - `/volume`：非数字、`NaN`/`Infinity`、超出 `[0,100]`
  - `/mode`：不在 `{seq, loop, random, rloop}` 中的值
  - `/seek`：`NaN`/`Infinity`、负数、字符串
  - `/play-at`：索引越界（**先**校验再停止当前播放，避免误杀正在播的歌）
- **修复 YouTube 平台路由**：`/play`、`/add`、`/playlist`、`/play-by-id`、`/add-by-id`、`/play-playlist` 现在都正确处理 `platform=youtube`（之前会静默回退到网易云）。
- **修复 `/auth/status?platform=youtube` 数据泄漏**：之前会回退到网易云并返回网易云用户的昵称 + 头像 URL，现在正确路由到 YouTube provider 并报告 `yt-dlp` 的实际可用状态。
- **`/auth/cookie` 拒绝 `platform=youtube`**，防止意外覆盖网易云 cookie。

**连接状态一致性**

- 断开连接时，音频命令（`play`/`add`/`next`/`prev`/`playlist`/`album`/`fm`）返回 **400 "Bot is not connected to TeamSpeak"**；配置类命令（`volume`/`mode`/`clear`/`stop`/`queue`/`now`/`lyrics`）仍可正常工作，保持 UI 可用。
- `resolveAndPlay` 在网络请求（URL 解析）前后都会检查 `this.connected`，防止在解析期间被 `stop()` 中断后仍然启动 ffmpeg。
- `tsClient` 的 `disconnected` 事件处理器现在总是清理播放器状态，不再因为 `connect()` 从未完成而遗留 `playing=true` 的僵尸状态。

**功能改进**

- **YouTube 音源（可选）**：新增基于 `yt-dlp` 的 YouTube provider，通过 `!play -y <关键词>` 或 WebUI 平台选项使用。未安装 `yt-dlp` 时静默降级、返回空结果，不影响其他音源。详见 [可选：YouTube 音源](#可选youtube-音源)。
- **Bot Selector UI**：
  - 始终可见（不再只有 ≥2 个机器人时才显示）
  - 尺寸放大（更大的按钮、字体、状态图标）
  - 每行增加 **电源按键**（一键启动/停止对应机器人，带禁用态与播放状态高亮）
  - 每行增加 **链接按钮**（复制机器人专属 URL）
  - 新路由 `/bot/:id`，打开后自动切换到对应机器人
- **服务器密码登录**：`serverPassword` 字段已加入数据库与 Settings UI，支持加入需要密码的 TS 服务器。
- **`!add` 一键开播**：在连接状态下向空队列 `!add` 歌曲时自动开始播放（之前只会入队，需要再 `!play` 或 `!next`）。
- **WebSocket 新增 `botRemoved` 事件**：删除机器人后 UI 会立即从列表中移除（之前需要手动刷新页面）。

**内部修复**

- **`PlayQueue.remove()` 当前歌曲移除 bug**：移除正在播放的歌曲时，`next()` 不再跳过紧跟其后的那首歌。
- **投票跳过**：需要的票数现在至少为 1（避免 `needed=0` 时单人"全票通过"的边界情况）；投票计数会在每首新歌开始时自动清零，不再跨歌曲泄漏。
- 多处输入边界修复：`seek` 防止 `NaN` 毒化 `seekOffset` 导致 `getElapsed()` 永久返回 `NaN`；`play-at` 越界时不再误杀当前播放。

### 历史重要变更

更早的变更请查阅 git log。主要里程碑：

- **初始 TS3/TS6 双协议支持**：自动协议检测（TS3 port 10011 vs TS6 port 10080）、TS6 HTTP Query 客户端、数据库持久化 `serverProtocol` / `ts6ApiKey`。
- **多机器人架构**：支持同一进程中运行多个机器人实例，独立队列、进度、音量；WebUI 一键切换。
- **网易云 / QQ 音乐 / 哔哩哔哩**：三平台原生音源，QR 码登录，Cookie 持久化。
- **Docker & systemd 部署**：一键部署脚本，数据卷持久化，自动重启支持。

## 致谢

感谢以下项目和开发者：

| 项目 | 说明 |
|------|------|
| [yichen11818/NeteaseTSBot](https://github.com/yichen11818/NeteaseTSBot) | TS6 协议兼容参考（vendored tsproto 补丁） |
| [Splamy/TS3AudioBot](https://github.com/Splamy/TS3AudioBot) | 优秀的 TeamSpeak 音频机器人框架 |
| [TS3AudioBot-BiliBiliPlugin](https://github.com/xxmod/TS3AudioBot-BiliBiliPlugin) | 提供插件开发参考 |
| [TS3AudioBot-NetEaseCloudmusic-plugin](https://github.com/ZHANGTIANYAO1/TS3AudioBot-NetEaseCloudmusic-plugin) | 提供插件开发参考和懒加载设计参考 |
| [TS3AudioBot-CloudMusic-plugin](https://github.com/577fkj/TS3AudioBot-Cloudmusic-plugin) | 提供插件开发参考 |
| [TS3AudioBot-Plugin-Netease-QQ](https://github.com/RayQuantum/TS3AudioBot-Plugin-Netease-QQ) | 提供插件开发参考 |
| [YesPlayMusic](https://github.com/qier222/YesPlayMusic) | UI 设计灵感 |
| [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) | 网易云音乐 API 项目 |
| [QQMusicApi](https://github.com/jsososo/QQMusicApi) | QQ 音乐 API 项目 |
| [@sansenjian/qq-music-api](https://github.com/sansenjian/qq-music-api) | QQ 音乐 API 活跃维护版本 |
| [@honeybbq/teamspeak-client](https://www.npmjs.com/package/@honeybbq/teamspeak-client) | TS3 完整客户端协议实现 |
| [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) | 哔哩哔哩 API 文档 |

## 开源许可

[MIT](LICENSE)
