import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { csrfOriginCheck } from "./csrf.js";

describe("csrfOriginCheck middleware", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(csrfOriginCheck);
    app.get("/", (_req, res) => res.json({ ok: true }));
    app.post("/", (_req, res) => res.json({ ok: true }));
  });

  it("allows safe methods (GET/HEAD/OPTIONS) without Origin", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
  });

  it("rejects POST without Origin or Referer", async () => {
    const res = await request(app).post("/");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "bad origin" });
  });

  it("accepts POST when Origin host matches request host", async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Origin", "https://example.com");
    expect(res.status).toBe(200);
  });

  it("rejects POST when Origin host does not match request host", async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Origin", "https://evil.com");
    expect(res.status).toBe(403);
  });

  it("accepts POST when Referer host matches and Origin is absent", async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Referer", "https://example.com/some/path");
    expect(res.status).toBe(200);
  });

  it("rejects POST when Referer host does not match", async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Referer", "https://evil.com/some/path");
    expect(res.status).toBe(403);
  });

  // Documents the server side of the QR-login outage: a `no-referrer` document
  // policy makes the browser send the literal `Origin: null` on same-origin
  // POSTs, which this guard cannot parse a host from and therefore rejects.
  // The fix lives in the frontend (referrer policy -> same-origin); this test
  // pins the gate behavior so the interaction stays understood. See
  // src/web/referrer-policy.test.ts.
  it('rejects POST with the literal Origin: "null" (no-referrer downgrade)', async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Origin", "null");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "bad origin" });
  });

  // API-key clients authenticate via a header the browser never attaches
  // automatically, so CSRF cannot abuse them — the origin check is skipped.
  it("allows POST with an X-API-Key header and no session cookie", async () => {
    const res = await request(app).post("/").set("X-API-Key", "tsmb_abc");
    expect(res.status).toBe(200);
  });

  it("allows POST with an Authorization: Bearer key and no session cookie", async () => {
    const res = await request(app).post("/").set("Authorization", "Bearer tsmb_abc");
    expect(res.status).toBe(200);
  });

  it("does NOT skip the origin check when a session cookie rides along with an API key", async () => {
    // An attacker page can set arbitrary headers while the victim's cookie is
    // attached ambiently — the cookie keeps the request under the gate.
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Origin", "https://evil.com")
      .set("Cookie", "tsmb_session=whatever")
      .set("X-API-Key", "tsmb_abc");
    expect(res.status).toBe(403);
  });
});
