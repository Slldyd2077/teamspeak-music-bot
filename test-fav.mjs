// 临时验证脚本：直接验证 BiliBiliProvider 的 B 站收藏夹实现（不依赖 WebUI / TS / admin）。
// 用法（在 fork 根目录）：
//   BILI_COOKIE="SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx" node test-fav.mjs
// cookie 获取：浏览器登录 B 站 → F12 → Application → Cookies → 复制 SESSDATA / DedeUserID / bili_jct
import { BiliBiliProvider } from "./dist/music/bilibili.js";

const cookie = process.env.BILI_COOKIE;
if (!cookie || !cookie.includes("SESSDATA")) {
  console.error("❌ 请用 BILI_COOKIE 环境变量传入有效的 B 站登录 cookie（至少含 SESSDATA）");
  process.exit(1);
}

const bili = new BiliBiliProvider();
bili.setCookie(cookie);

console.log("→ 拉取收藏夹列表 ...");
const playlists = await bili.getUserPlaylists();
console.log(`✓ 收藏夹 ${playlists.length} 个：`);
for (const p of playlists) console.log(`   · [${p.id}] ${p.name}  (${p.songCount} 个视频)`);

if (playlists.length > 0) {
  const target = playlists[0];
  console.log(`\n→ 拉取收藏夹「${target.name}」内视频 ...`);
  const songs = await bili.getPlaylistSongs(target.id);
  console.log(`✓ 视频 ${songs.length} 个（失效项已过滤）：`);
  for (const s of songs.slice(0, 5)) console.log(`   · ${s.name} — ${s.artist}  (bvid=${s.id})`);
}
console.log("\n✅ 验证完成。");
