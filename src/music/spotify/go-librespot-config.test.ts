// src/music/spotify/go-librespot-config.test.ts
import { describe, it, expect } from "vitest";
import { renderConfigYml, type GoLibrespotConfigOptions } from "./go-librespot-config.js";

const OPTS: GoLibrespotConfigOptions = {
  deviceName: "TeamSpeak Music Bot",
  bitrate: 320,
  fifoPath: "/tmp/go-librespot.fifo",
  apiAddress: "0.0.0.0",
  apiPort: 3678,
  callbackPort: 8080,
};

/**
 * Minimal 2-level YAML reader for the exact shape renderConfigYml emits
 * (flat scalars + one level of nesting under `server:` / `credentials:`).
 * Avoids adding a yaml dependency while still proving the output round-trips.
 */
function parseTinyYaml(src: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
    { indent: -1, obj: root },
  ];
  for (const rawLine of src.split("\n")) {
    if (rawLine.trim() === "") continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const idx = line.indexOf(":");
    const key = line.slice(0, idx).trim();
    let valRaw = line.slice(idx + 1).trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;
    if (valRaw === "") {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
      continue;
    }
    let val: unknown = valRaw;
    if (valRaw.startsWith('"') && valRaw.endsWith('"')) val = JSON.parse(valRaw);
    else if (valRaw === "true") val = true;
    else if (valRaw === "false") val = false;
    else if (/^-?\d+$/.test(valRaw)) val = Number(valRaw);
    parent[key] = val;
  }
  return root;
}

describe("renderConfigYml", () => {
  it("emits the exact top-level go-librespot keys/values", () => {
    const lines = renderConfigYml(OPTS).split("\n");
    expect(lines).toContain('device_name: "TeamSpeak Music Bot"');
    expect(lines).toContain("device_type: computer");
    expect(lines).toContain("bitrate: 320");
    expect(lines).toContain("audio_backend: pipe");
    expect(lines).toContain("audio_output_pipe: /tmp/go-librespot.fifo");
    expect(lines).toContain("audio_output_pipe_format: s16le");
  });

  it("emits a server block with enabled/address/port set explicitly", () => {
    const parsed = parseTinyYaml(renderConfigYml(OPTS));
    expect(parsed.server).toEqual({
      enabled: true,
      address: "0.0.0.0",
      port: 3678,
    });
  });

  it("emits interactive OAuth credentials with the callback port", () => {
    const parsed = parseTinyYaml(renderConfigYml(OPTS));
    expect(parsed.credentials).toEqual({
      type: "interactive",
      interactive: { callback_port: 8080 },
    });
  });

  it("full round-trip reflects every provided option", () => {
    const parsed = parseTinyYaml(renderConfigYml(OPTS));
    expect(parsed).toEqual({
      device_name: "TeamSpeak Music Bot",
      device_type: "computer",
      bitrate: 320,
      audio_backend: "pipe",
      audio_output_pipe: "/tmp/go-librespot.fifo",
      audio_output_pipe_format: "s16le",
      server: { enabled: true, address: "0.0.0.0", port: 3678 },
      credentials: { type: "interactive", interactive: { callback_port: 8080 } },
    });
  });

  it("threads distinct option values through unchanged (no hard-coded ports)", () => {
    const parsed = parseTinyYaml(
      renderConfigYml({
        deviceName: "Other Bot",
        bitrate: 160,
        fifoPath: "/run/librespot/pipe",
        apiAddress: "127.0.0.1",
        apiPort: 4000,
        callbackPort: 9099,
      }),
    );
    expect(parsed).toMatchObject({
      device_name: "Other Bot",
      bitrate: 160,
      audio_output_pipe: "/run/librespot/pipe",
      server: { address: "127.0.0.1", port: 4000 },
      credentials: { interactive: { callback_port: 9099 } },
    });
  });

  it("safely quotes device names containing special characters", () => {
    const yml = renderConfigYml({ ...OPTS, deviceName: 'My "Cool" Bot' });
    expect(yml.split("\n")).toContain('device_name: "My \\"Cool\\" Bot"');
    // and still round-trips back to the original string
    expect(parseTinyYaml(yml).device_name).toBe('My "Cool" Bot');
  });
});
