import axios, { type AxiosInstance } from "axios";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Player-control scopes requested for the USER token: streaming (drives
 * librespot as a Connect device) + read/modify playback + currently-playing +
 * private-playlist reads.
 */
export const SPOTIFY_CONTROL_SCOPES =
  "streaming user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private";

const ACCOUNTS_BASE = "https://accounts.spotify.com";
// Hand a token back only if it survives ~30s, matching webapi.ts's skew.
const EXPIRY_SKEW_MS = 30_000;
// RFC 7636 §4.1 unreserved set: [A-Za-z0-9-._~].
const PKCE_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

export interface OAuthTokenStore {
  load(): OAuthTokens | null;
  save(t: OAuthTokens): void;
  clear(): void;
}

export interface SpotifyOAuthOptions {
  /**
   * Correction C3.2: the caller's OWN Spotify Developer app client_id. There is
   * no librespot-public-client fallback — an empty clientId disables OAuth.
   */
  clientId?: string;
  /**
   * Loopback redirect registered on the caller's Spotify app, supplied by the
   * bot's web layer (e.g. its `/api/spotify/callback`). Must exactly match the
   * value used at both the authorize and token steps.
   */
  redirectUri?: string;
  store: OAuthTokenStore;
  deps?: { http?: AxiosInstance };
}

/** 64 random chars from the PKCE unreserved set (43-128 allowed by the spec). */
export function generateCodeVerifier(): string {
  const bytes = randomBytes(64);
  let out = "";
  for (let i = 0; i < 64; i++) out += PKCE_CHARS[bytes[i] % PKCE_CHARS.length];
  return out;
}

/** base64url(SHA256(verifier)) with no padding — the S256 code challenge. */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Persist OAuth tokens as a 0600 JSON file (used by the controller). */
export function createFileOAuthTokenStore(filePath: string): OAuthTokenStore {
  return {
    load() {
      try {
        if (!existsSync(filePath)) return null;
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
        return parsed?.refreshToken ? (parsed as OAuthTokens) : null;
      } catch {
        return null; // missing/corrupt -> treat as unauthorized
      }
    },
    save(t: OAuthTokens) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(t, null, 2), { mode: 0o600 });
    },
    clear() {
      try {
        rmSync(filePath, { force: true });
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Authorization Code + PKCE flow for the USER player-control token. Public
 * client (no secret).
 *
 * Correction C3.2: this REQUIRES the operator's own registered Spotify app —
 * there is NO reuse of librespot's first-party keymaster client / fixed
 * :5588 redirect. Without a clientId, `isAuthorized()` is false and
 * `buildAuthorizeUrl()` throws.
 *
 * Refresh rotates the refresh token, so the newest is always persisted;
 * invalid_grant clears the store (re-login required). Access/refresh tokens
 * are never logged.
 */
export class SpotifyOAuth {
  private clientId: string;
  private redirectUri: string;
  private store: OAuthTokenStore;
  private http: AxiosInstance;
  // Pending PKCE verifiers keyed by state, awaiting the loopback redirect back.
  private pendingVerifiers = new Map<string, string>();

  constructor(o: SpotifyOAuthOptions) {
    this.clientId = o.clientId ?? "";
    this.redirectUri = o.redirectUri ?? "";
    this.store = o.store;
    this.http =
      o.deps?.http ?? axios.create({ baseURL: ACCOUNTS_BASE, timeout: 15_000 });
  }

  getClientId(): string {
    return this.clientId;
  }

  getRedirectUri(): string {
    return this.redirectUri;
  }

  isAuthorized(): boolean {
    // C3.2: no client_id means we could never refresh, so treat as unauthorized.
    return !!this.clientId && !!this.store.load()?.refreshToken;
  }

  buildAuthorizeUrl(): { url: string; state: string } {
    if (!this.clientId) {
      // C3.2: cannot start OAuth against nobody's app.
      throw new Error("Set your Spotify Client ID in settings first");
    }
    const state = randomBytes(16).toString("hex");
    const verifier = generateCodeVerifier();
    this.pendingVerifiers.set(state, verifier);
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: "code",
      redirect_uri: this.redirectUri,
      code_challenge: codeChallengeS256(verifier),
      code_challenge_method: "S256",
      scope: SPOTIFY_CONTROL_SCOPES,
      state,
    });
    return { url: `${ACCOUNTS_BASE}/authorize?${params.toString()}`, state };
  }

  async handleCallback(code: string, state: string): Promise<boolean> {
    const verifier = this.pendingVerifiers.get(state);
    if (!verifier) return false; // unknown/expired state -> CSRF guard
    // C3.7: drop the state->verifier entry on EVERY terminal path (success,
    // rejected token exchange, or throw) so a failed login can't leak/replay it.
    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        code_verifier: verifier,
      });
      const { data } = await this.http.post("/api/token", body.toString(), {
        headers: FORM_HEADERS,
      });
      if (!data?.access_token || !data?.refresh_token) return false;
      this.store.save(this.toTokens(data, data.refresh_token, data.scope));
      return true;
    } catch {
      return false;
    } finally {
      this.pendingVerifiers.delete(state);
    }
  }

  async getAccessToken(): Promise<string | null> {
    if (!this.clientId) return null; // C3.2: no app => nothing to mint against
    const tokens = this.store.load();
    if (!tokens?.refreshToken) return null; // unauthorized
    if (tokens.accessToken && Date.now() < tokens.expiresAt) {
      return tokens.accessToken;
    }
    return this.refresh(tokens);
  }

  private async refresh(current: OAuthTokens): Promise<string | null> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: this.clientId,
    });
    try {
      const { data } = await this.http.post("/api/token", body.toString(), {
        headers: FORM_HEADERS,
      });
      if (!data?.access_token) return null;
      // PKCE rotates the refresh token; fall back to the current one if omitted.
      const rotated = data.refresh_token || current.refreshToken;
      const saved = this.toTokens(data, rotated, data.scope ?? current.scope);
      this.store.save(saved);
      return saved.accessToken;
    } catch (err: any) {
      // invalid_grant => refresh token revoked/expired: discard, force re-login.
      if (err?.response?.data?.error === "invalid_grant") this.store.clear();
      return null;
    }
  }

  private toTokens(data: any, refreshToken: string, scope: string): OAuthTokens {
    return {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - EXPIRY_SKEW_MS,
      scope: scope ?? SPOTIFY_CONTROL_SCOPES,
    };
  }
}
