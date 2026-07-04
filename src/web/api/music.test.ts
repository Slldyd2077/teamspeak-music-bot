import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import type { MusicProvider, SearchResult } from "../../music/provider.js";
import { createMusicRouter } from "./music.js";

function fakeProvider(platform: MusicProvider["platform"]): MusicProvider {
  const empty: SearchResult = { songs: [], albums: [], playlists: [] };
  return {
    platform,
    search: vi.fn().mockResolvedValue(empty),
  } as unknown as MusicProvider;
}

describe("music router GET /search offset pagination", () => {
  let app: express.Express;
  let netease: MusicProvider;

  beforeEach(() => {
    netease = fakeProvider("netease");
    const router = createMusicRouter(
      netease,
      fakeProvider("qq"),
      fakeProvider("bilibili"),
      pino({ level: "silent" })
    );
    app = express();
    app.use("/api/music", router);
  });

  it("parses offset and passes it as the 3rd arg to provider.search", async () => {
    const res = await request(app).get("/api/music/search?q=hello&limit=20&offset=20");
    expect(res.status).toBe(200);
    expect(netease.search).toHaveBeenCalledWith("hello", 20, 20);
  });

  it("defaults a missing offset to 0", async () => {
    const res = await request(app).get("/api/music/search?q=hello&limit=20");
    expect(res.status).toBe(200);
    expect(netease.search).toHaveBeenCalledWith("hello", 20, 0);
  });

  it("clamps a negative offset to 0", async () => {
    const res = await request(app).get("/api/music/search?q=hello&limit=20&offset=-5");
    expect(res.status).toBe(200);
    expect(netease.search).toHaveBeenCalledWith("hello", 20, 0);
  });
});
