import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SpotifyOAuth,
  SPOTIFY_CONTROL_SCOPES,
  generateCodeVerifier,
  codeChallengeS256,
  createFileOAuthTokenStore,
  type OAuthTokens,
  type OAuthTokenStore,
} from "./spotify-oauth.js";

// Wrap the fs functions the token store uses in call-through spies so the
// atomic-write path (temp file + rename) can be observed/forced. Everything else
// (mkdtemp, rmSync, readdir, …) is the real implementation via `...actual`, so
// all other tests keep real filesystem behavior. `vi.spyOn` can't be used here
// because the node:fs ESM namespace is non-configurable in this setup.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

// Correction C3.2: the control OAuth REQUIRES a user-provided client_id (their
// own Spotify Developer app) + caller-supplied loopback redirect. There is NO
// librespot public-client / :5588 default.
const CLIENT_ID = "test-client-id";
const REDIRECT_URI = "http://127.0.0.1:8888/api/spotify/callback";

/** In-memory store exposing `.value` so tests can assert persistence. */
function memStore(
  initial: OAuthTokens | null = null,
): OAuthTokenStore & { value: OAuthTokens | null } {
  const s = {
    value: initial,
    load() {
      return s.value;
    },
    save(t: OAuthTokens) {
      s.value = t;
    },
    clear() {
      s.value = null;
    },
  };
  return s;
}

/** A manually-settled promise, to hold a token POST "in flight" during a test. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PKCE helpers", () => {
  it("generateCodeVerifier returns 64 chars from the unreserved set", () => {
    const v = generateCodeVerifier();
    expect(v).toHaveLength(64);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
    expect(generateCodeVerifier()).not.toBe(v); // random
  });

  it("codeChallengeS256 is base64url(sha256) with no padding (43 chars)", () => {
    const c = codeChallengeS256("abc123");
    expect(c).toHaveLength(43); // 32-byte digest -> 43 base64url chars
    expect(c).not.toContain("=");
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("SpotifyOAuth.buildAuthorizeUrl", () => {
  it("builds accounts.spotify.com/authorize with the caller's clientId + redirectUri + S256", () => {
    const oauth = new SpotifyOAuth({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      store: memStore(),
    });
    const { url, state } = oauth.buildAuthorizeUrl();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.spotify.com/authorize");
    const p = u.searchParams;
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toHaveLength(43);
    expect(p.get("scope")).toBe(SPOTIFY_CONTROL_SCOPES);
    expect(p.get("state")).toBe(state);
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(oauth.getClientId()).toBe(CLIENT_ID);
    expect(oauth.getRedirectUri()).toBe(REDIRECT_URI);
  });

  // Correction C3.2: no clientId => cannot start OAuth; throw a clear message.
  it("throws a clear error when clientId is empty", () => {
    const oauth = new SpotifyOAuth({ redirectUri: REDIRECT_URI, store: memStore() });
    expect(() => oauth.buildAuthorizeUrl()).toThrow(/Client ID/i);
  });
});

describe("SpotifyOAuth.isAuthorized (C3.2)", () => {
  it("is false without a clientId even if a refresh token is stored", () => {
    const store = memStore({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 60_000,
      scope: "s",
    });
    const oauth = new SpotifyOAuth({ redirectUri: REDIRECT_URI, store });
    expect(oauth.isAuthorized()).toBe(false);
  });

  it("is true with a clientId and a stored refresh token", () => {
    const store = memStore({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 60_000,
      scope: "s",
    });
    const oauth = new SpotifyOAuth({ clientId: CLIENT_ID, store });
    expect(oauth.isAuthorized()).toBe(true);
  });
});

describe("SpotifyOAuth.handleCallback", () => {
  it("exchanges the code (PKCE verifier matches the authorize challenge) and persists tokens", async () => {
    const store = memStore();
    const http = {
      post: vi.fn().mockResolvedValue({
        data: {
          access_token: "a1",
          refresh_token: "r1",
          expires_in: 3600,
          scope: SPOTIFY_CONTROL_SCOPES,
        },
      }),
    } as any;
    const oauth = new SpotifyOAuth({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      store,
      deps: { http },
    });

    const { url, state } = oauth.buildAuthorizeUrl();
    const challenge = new URL(url).searchParams.get("code_challenge")!;

    const ok = await oauth.handleCallback("CODE123", state);
    expect(ok).toBe(true);

    const [path, bodyStr, cfg] = http.post.mock.calls[0];
    expect(path).toBe("/api/token");
    expect(cfg.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(bodyStr as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("CODE123");
    expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(body.get("client_id")).toBe(CLIENT_ID);
    // The verifier sent MUST hash to the challenge advertised in the authorize URL.
    const verifier = body.get("code_verifier")!;
    expect(codeChallengeS256(verifier)).toBe(challenge);

    expect(store.value?.accessToken).toBe("a1");
    expect(store.value?.refreshToken).toBe("r1");
    expect(store.value?.expiresAt).toBeGreaterThan(Date.now());
    expect(oauth.isAuthorized()).toBe(true);
  });

  it("rejects an unknown state without calling the token endpoint (CSRF guard)", async () => {
    const http = { post: vi.fn() } as any;
    const oauth = new SpotifyOAuth({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      store: memStore(),
      deps: { http },
    });
    expect(await oauth.handleCallback("CODE", "not-a-real-state")).toBe(false);
    expect(http.post).not.toHaveBeenCalled();
  });

  // Correction C3.7: the state->verifier entry is deleted on EVERY terminal
  // path (finally), so a failed login never leaks it and cannot be replayed.
  it("deletes the pending verifier even when the token exchange fails", async () => {
    const http = {
      post: vi.fn().mockRejectedValue({
        response: { status: 400, data: { error: "invalid_grant" } },
      }),
    } as any;
    const oauth = new SpotifyOAuth({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      store: memStore(),
      deps: { http },
    });
    const { state } = oauth.buildAuthorizeUrl();

    // First attempt fails at the network/token step.
    expect(await oauth.handleCallback("CODE", state)).toBe(false);
    expect(http.post).toHaveBeenCalledTimes(1);

    // Replaying the same state now fails the CSRF guard (verifier was deleted),
    // WITHOUT hitting the token endpoint again.
    expect(await oauth.handleCallback("CODE", state)).toBe(false);
    expect(http.post).toHaveBeenCalledTimes(1);
  });
});

describe("SpotifyOAuth.getAccessToken", () => {
  it("returns the cached token without refreshing when still valid", async () => {
    const http = { post: vi.fn() } as any;
    const store = memStore({
      accessToken: "cached",
      refreshToken: "r1",
      expiresAt: Date.now() + 60_000,
      scope: "s",
    });
    const oauth = new SpotifyOAuth({ clientId: CLIENT_ID, store, deps: { http } });
    expect(await oauth.getAccessToken()).toBe("cached");
    expect(http.post).not.toHaveBeenCalled();
  });

  it("refreshes when expired and persists the ROTATED refresh token", async () => {
    const store = memStore({
      accessToken: "old",
      refreshToken: "r1",
      expiresAt: Date.now() - 1000,
      scope: "s",
    });
    const http = {
      post: vi.fn().mockResolvedValue({
        data: { access_token: "a2", refresh_token: "r2", expires_in: 3600 },
      }),
    } as any;
    const oauth = new SpotifyOAuth({ clientId: CLIENT_ID, store, deps: { http } });

    expect(await oauth.getAccessToken()).toBe("a2");
    const body = new URLSearchParams(http.post.mock.calls[0][1] as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("r1");
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(store.value?.refreshToken).toBe("r2"); // rotated + persisted
    expect(store.value?.accessToken).toBe("a2");
  });

  it("keeps the old refresh token when the refresh response omits a new one", async () => {
    const store = memStore({
      accessToken: "old",
      refreshToken: "r1",
      expiresAt: Date.now() - 1000,
      scope: "s",
    });
    const http = {
      post: vi.fn().mockResolvedValue({ data: { access_token: "a2", expires_in: 3600 } }),
    } as any;
    const oauth = new SpotifyOAuth({ clientId: CLIENT_ID, store, deps: { http } });
    expect(await oauth.getAccessToken()).toBe("a2");
    expect(store.value?.refreshToken).toBe("r1");
  });

  it("clears the store and returns null on invalid_grant (expired refresh token)", async () => {
    const store = memStore({
      accessToken: "old",
      refreshToken: "r1",
      expiresAt: Date.now() - 1000,
      scope: "s",
    });
    const http = {
      post: vi.fn().mockRejectedValue({
        response: { status: 400, data: { error: "invalid_grant" } },
      }),
    } as any;
    const oauth = new SpotifyOAuth({ clientId: CLIENT_ID, store, deps: { http } });
    expect(await oauth.getAccessToken()).toBeNull();
    expect(store.value).toBeNull();
    expect(oauth.isAuthorized()).toBe(false);
  });

  it("returns null when unauthorized (no stored refresh token)", async () => {
    const http = { post: vi.fn() } as any;
    const oauth = new SpotifyOAuth({
      clientId: CLIENT_ID,
      store: memStore(),
      deps: { http },
    });
    expect(await oauth.getAccessToken()).toBeNull();
    expect(oauth.isAuthorized()).toBe(false);
    expect(http.post).not.toHaveBeenCalled();
  });
});

// S4.3: refresh-token rotation makes two concurrent refreshes race — the second
// would POST with a token the first already invalidated. Collapse them into one.
describe("SpotifyOAuth.getAccessToken (in-flight refresh, S4.3)", () => {
  it("collapses concurrent refreshes into a single token POST", async () => {
    let t = 0;
    const now = () => t;
    const store = memStore({
      accessToken: "old",
      refreshToken: "r1",
      expiresAt: 0, // now()=0 is not < 0 -> expired -> must refresh
      scope: "s",
    });
    const d = deferred<any>();
    const http = { post: vi.fn().mockReturnValue(d.promise) } as any;
    const oauth = new SpotifyOAuth({
      clientId: CLIENT_ID,
      store,
      deps: { http, now },
    });

    // Fire two calls while the POST is still pending.
    const p1 = oauth.getAccessToken();
    const p2 = oauth.getAccessToken();
    expect(http.post).toHaveBeenCalledTimes(1); // collapsed to ONE POST

    d.resolve({
      data: { access_token: "a2", refresh_token: "r2", expires_in: 3600 },
    });
    expect(await p1).toBe("a2");
    expect(await p2).toBe("a2");
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(store.value?.refreshToken).toBe("r2"); // rotated once, not twice
  });

  it("clears the in-flight refresh after it settles, allowing a later refresh", async () => {
    let t = 0;
    const now = () => t;
    const store = memStore({
      accessToken: "old",
      refreshToken: "r1",
      expiresAt: 0,
      scope: "s",
    });
    const http = {
      post: vi
        .fn()
        .mockResolvedValueOnce({
          data: { access_token: "a2", refresh_token: "r2", expires_in: 3600 },
        })
        .mockResolvedValueOnce({
          data: { access_token: "a3", refresh_token: "r3", expires_in: 3600 },
        }),
    } as any;
    const oauth = new SpotifyOAuth({
      clientId: CLIENT_ID,
      store,
      deps: { http, now },
    });

    expect(await oauth.getAccessToken()).toBe("a2");
    expect(http.post).toHaveBeenCalledTimes(1);

    // toTokens now uses this.now(): saved expiresAt = 0 + 3600s - 30s skew.
    // Still valid at t=0 -> cached, no new POST.
    expect(await oauth.getAccessToken()).toBe("a2");
    expect(http.post).toHaveBeenCalledTimes(1);

    // Advance past the newly-saved expiry -> in-flight was cleared, so a fresh
    // refresh fires (proves .finally() reset refreshInFlight).
    t = 3600 * 1000;
    expect(await oauth.getAccessToken()).toBe("a3");
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(store.value?.refreshToken).toBe("r3");
  });
});

// S4.3: bound the PKCE verifier map so abandoned logins can't accumulate.
describe("SpotifyOAuth PKCE verifier TTL + cap (S4.3)", () => {
  it("expires a pending verifier after the TTL (handleCallback returns false)", async () => {
    let t = 0;
    const now = () => t;
    const http = { post: vi.fn() } as any;
    const oauth = new SpotifyOAuth({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      store: memStore(),
      deps: { http, now },
    });
    const { state } = oauth.buildAuthorizeUrl();

    t = 10 * 60 * 1000 + 1; // VERIFIER_TTL_MS + 1
    expect(await oauth.handleCallback("CODE", state)).toBe(false);
    expect(http.post).not.toHaveBeenCalled(); // never reached the token step
  });

  it("caps the verifier map, evicting the oldest state (behavioral)", async () => {
    let t = 0;
    const now = () => t;
    const http = {
      post: vi.fn().mockResolvedValue({
        data: { access_token: "a1", refresh_token: "r1", expires_in: 3600 },
      }),
    } as any;
    const oauth = new SpotifyOAuth({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      store: memStore(),
      deps: { http, now },
    });

    // First (oldest) state, then enough more to exceed VERIFIER_MAX (32).
    const first = oauth.buildAuthorizeUrl().state;
    let last = first;
    for (let i = 0; i < 32; i++) last = oauth.buildAuthorizeUrl().state;

    // The oldest was evicted -> unknown state -> CSRF guard, no token POST.
    expect(await oauth.handleCallback("CODE", first)).toBe(false);
    expect(http.post).not.toHaveBeenCalled();

    // A still-pending (newest) state DOES resolve -> only the oldest was dropped.
    expect(await oauth.handleCallback("CODE", last)).toBe(true);
    expect(http.post).toHaveBeenCalledTimes(1);
  });
});

// Whole-branch I2: a UI-entered Client ID (saved in Settings) must reach the
// single live SpotifyOAuth WITHOUT a process restart. configure() re-arms the
// runtime credentials; an empty clientId re-disables OAuth.
describe("SpotifyOAuth.configure (runtime credentials, whole-branch I2)", () => {
  it("applies a UI-entered clientId + redirectUri so OAuth arms without a restart", () => {
    // Fresh install: boot-time config had no clientId, so OAuth is disabled.
    const store = memStore({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 60_000,
      scope: "s",
    });
    const oauth = new SpotifyOAuth({ clientId: "", store });
    expect(oauth.isAuthorized()).toBe(false);
    expect(() => oauth.buildAuthorizeUrl()).toThrow(/Client ID/i);

    // Operator enters creds in Settings -> POST /settings calls configure().
    const REDIRECT = "http://127.0.0.1:3000/api/spotify/callback";
    oauth.configure("cid", REDIRECT);
    expect(oauth.getClientId()).toBe("cid");
    expect(oauth.getRedirectUri()).toBe(REDIRECT);
    // Now authorize + isAuthorized work against the newly-supplied app.
    expect(oauth.isAuthorized()).toBe(true);
    const { url } = oauth.buildAuthorizeUrl();
    const p = new URL(url).searchParams;
    expect(p.get("client_id")).toBe("cid");
    expect(p.get("redirect_uri")).toBe(REDIRECT);
  });

  it("trims the clientId and re-disables OAuth when cleared", () => {
    const oauth = new SpotifyOAuth({
      clientId: "old",
      redirectUri: "http://old",
      store: memStore(),
    });
    oauth.configure("  cid  ", "http://127.0.0.1:3000/api/spotify/callback");
    expect(oauth.getClientId()).toBe("cid"); // trimmed

    // Empty clientId disables OAuth again (gate on buildAuthorizeUrl/isAuthorized).
    oauth.configure("");
    expect(oauth.getClientId()).toBe("");
    expect(oauth.getRedirectUri()).toBe("");
    expect(oauth.isAuthorized()).toBe(false);
    expect(() => oauth.buildAuthorizeUrl()).toThrow(/Client ID/i);
  });
});

describe("createFileOAuthTokenStore", () => {
  it("round-trips save/load and clear() removes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "sp-oauth-"));
    const file = join(dir, "nested", "tokens.json");
    try {
      const store = createFileOAuthTokenStore(file);
      expect(store.load()).toBeNull(); // missing file
      const t: OAuthTokens = {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 123,
        scope: "s",
      };
      store.save(t);
      expect(store.load()).toEqual(t);
      store.clear();
      expect(store.load()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// R3-5: the token store save() must be atomic (same-dir temp file + rename), so
// a crash / power loss / ENOSPC while persisting a ROTATED refresh token (Spotify
// invalidates the OLD one the instant it responds — the new one lives only in
// memory until this write lands) can never truncate the file and silently
// de-authenticate the operator. Mirrors the hardened config.ts saveConfig.
describe("createFileOAuthTokenStore atomic write (R3-5)", () => {
  const dirs: string[] = [];
  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "sp-oauth-atomic-"));
    dirs.push(dir);
    return dir;
  }
  beforeEach(() => {
    vi.clearAllMocks(); // reset call history, keep the call-through implementations
  });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  const TOK: OAuthTokens = {
    accessToken: "a",
    refreshToken: "r",
    expiresAt: 123,
    scope: "s",
  };

  it("round-trips save/load and leaves NO .tmp file behind", () => {
    const dir = makeTmpDir();
    const file = join(dir, "tokens.json");
    const store = createFileOAuthTokenStore(file);

    store.save(TOK);

    expect(store.load()).toEqual(TOK);
    // No temp remnants in the target directory.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("writes via a same-dir temp file then renameSync onto the final path", () => {
    const dir = makeTmpDir();
    const file = join(dir, "tokens.json");

    createFileOAuthTokenStore(file).save(TOK);

    expect(vi.mocked(renameSync)).toHaveBeenCalled();
    const [from, to] = vi.mocked(renameSync).mock.calls[0] as [string, string];
    expect(to).toBe(file); // renamed ONTO the real path
    expect(String(from)).not.toBe(file); // ...from a distinct temp file
    expect(join(String(from), "..")).toBe(join(file, "..")); // ...in the SAME dir
  });

  it("persists the token file with 0600 permissions (POSIX)", () => {
    if (process.platform === "win32") return; // mode bits aren't meaningful on Windows
    const dir = makeTmpDir();
    const file = join(dir, "tokens.json");
    createFileOAuthTokenStore(file).save(TOK);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("does NOT truncate/corrupt a pre-existing valid token file when the write fails mid-way", () => {
    const dir = makeTmpDir();
    const file = join(dir, "tokens.json");
    const store = createFileOAuthTokenStore(file);

    // A valid, previously-persisted token file (the live refresh token on disk).
    store.save(TOK);
    const before = readFileSync(file, "utf-8");

    // Simulate a crash / ENOSPC at the atomic-replace step while persisting a
    // ROTATED refresh token.
    const rotated: OAuthTokens = { ...TOK, accessToken: "a2", refreshToken: "r2" };
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("rename boom");
    });

    expect(() => store.save(rotated)).toThrow(/rename boom/);

    // The original file is untouched: present, byte-identical, still parseable.
    expect(readFileSync(file, "utf-8")).toBe(before);
    expect(store.load()).toEqual(TOK);
    // ...and the failed write left no temp file lying around.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});
