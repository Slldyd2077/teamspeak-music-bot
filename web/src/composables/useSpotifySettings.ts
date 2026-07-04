export interface SpotifyConfigForm {
  enabled: boolean;
  backend: "auto" | "go-librespot" | "librespot";
  clientId: string;
  clientSecret: string; // blank means "unchanged"
  deviceName: string;
  bitrate: number;
}

export interface SpotifyStatus {
  authorized: boolean;
  backend: string;
  deviceName: string;
  binaryAvailable: boolean;
}

// 实验性 · 灰色地带 · 需要 Premium · 使用你自己的开发者应用凭据
export const SPOTIFY_DISCLAIMER =
  "实验性功能：通过 librespot 播放 Spotify 需要 Spotify Premium 账号，并使用你自己注册的 Spotify 开发者应用凭据。" +
  "该方式处于 Spotify 服务条款的灰色地带，风险自负；默认关闭，不会内置任何共享凭据。";

export function buildSpotifyPayload(f: SpotifyConfigForm): { spotify: Record<string, unknown> } {
  const spotify: Record<string, unknown> = {
    enabled: f.enabled,
    backend: f.backend,
    clientId: f.clientId,
    deviceName: f.deviceName,
    bitrate: f.bitrate,
  };
  if (f.clientSecret && f.clientSecret.length > 0) spotify.clientSecret = f.clientSecret;
  return { spotify };
}

export function parseSpotifyRedirect(search: string): "success" | "error" | null {
  const v = new URLSearchParams(search).get("spotify");
  return v === "success" || v === "error" ? v : null;
}

export function statusSummary(
  s: SpotifyStatus | null,
  enabled: boolean,
): { label: string; tone: "ok" | "warn" | "off" } {
  if (!enabled) return { label: "已关闭", tone: "off" };
  if (!s) return { label: "未知", tone: "warn" };
  if (!s.binaryAvailable) return { label: "未检测到 librespot 可执行文件", tone: "warn" };
  if (!s.authorized) return { label: "未授权（点击“连接 Spotify”登录）", tone: "warn" };
  return { label: `已就绪 · 后端 ${s.backend}`, tone: "ok" };
}
