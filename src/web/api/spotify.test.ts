import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { createSpotifyRouter, type SpotifyOAuthLike } from "./spotify.js";

type Role = "admin" | "member" | "guest";
function makeApp(oauth: SpotifyOAuthLike, role: Role = "admin", caps: string[] = []) {
  const app = express();
  app.use(express.json());
  // Stand in for the global requireAuth that populates req.user.
  app.use((req, _res, next) => {
    (req as any).user = { role, capabilities: new Set(caps) };
    next();
  });
  app.use(
    "/api/spotify",
    createSpotifyRouter({
      oauth,
      logger: pino({ level: "silent" }),
      getBackendInfo: () => ({ backend: "librespot", deviceName: "TS-Bot" }),
      webUiRedirect: "/",
    }),
  );
  return app;
}

function fakeOauth(over: Partial<SpotifyOAuthLike> = {}): SpotifyOAuthLike {
  return {
    buildAuthorizeUrl: () => ({ url: "https://accounts.spotify.com/authorize?x=1", state: "st" }),
    handleCallback: async () => true,
    isAuthorized: () => false,
    ...over,
  };
}

describe("spotify OAuth router", () => {
  it("GET /login returns the authorize url for a permitted user", async () => {
    const app = makeApp(fakeOauth());
    const res = await request(app).get("/api/spotify/login");
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("accounts.spotify.com/authorize");
  });

  it("GET /login is 403 for a member lacking platform.auth", async () => {
    const app = makeApp(fakeOauth(), "member", []);
    const res = await request(app).get("/api/spotify/login");
    expect(res.status).toBe(403);
  });

  it("GET /callback with a good code+state redirects to success", async () => {
    const handleCallback = vi.fn(async () => true);
    const app = makeApp(fakeOauth({ handleCallback }));
    const res = await request(app).get("/api/spotify/callback?code=abc&state=st");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?spotify=success");
    expect(handleCallback).toHaveBeenCalledWith("abc", "st");
  });

  it("GET /callback with a bad state (handleCallback false) redirects to error", async () => {
    const app = makeApp(fakeOauth({ handleCallback: async () => false }));
    const res = await request(app).get("/api/spotify/callback?code=abc&state=WRONG");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?spotify=error");
  });

  it("GET /callback with missing code does not call oauth and redirects to error", async () => {
    const handleCallback = vi.fn(async () => true);
    const app = makeApp(fakeOauth({ handleCallback }));
    const res = await request(app).get("/api/spotify/callback?state=st");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?spotify=error");
    expect(handleCallback).not.toHaveBeenCalled();
  });

  it("GET /callback swallows a throwing handleCallback and redirects to error", async () => {
    const app = makeApp(fakeOauth({ handleCallback: async () => { throw new Error("boom"); } }));
    const res = await request(app).get("/api/spotify/callback?code=abc&state=st");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?spotify=error");
  });

  it("GET /status reflects authorized + backend + deviceName", async () => {
    const app = makeApp(fakeOauth({ isAuthorized: () => true }));
    const res = await request(app).get("/api/spotify/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authorized: true, backend: "librespot", deviceName: "TS-Bot" });
  });

  it("GET /status is 403 for a guest", async () => {
    const app = makeApp(fakeOauth(), "guest");
    const res = await request(app).get("/api/spotify/status");
    expect(res.status).toBe(403);
  });
});
