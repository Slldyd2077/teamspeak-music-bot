// src/music/spotify/go-librespot-config.ts
// Hand-built go-librespot config.yml. Keys/values verified against
// devgianlu/go-librespot cmd/daemon/cli_config.go koanf tags. No yaml
// dependency is used; the file is a small, fixed-shape document.

export interface GoLibrespotConfigOptions {
  deviceName: string;
  bitrate: number;
  fifoPath: string;
  apiAddress: string;
  apiPort: number;
  callbackPort: number;
}

/**
 * Render a headless go-librespot config.yml:
 *  - pipe audio backend writing raw 44.1kHz/s16le stereo PCM to a FIFO,
 *  - HTTP+WebSocket control server enabled (port has NO built-in default,
 *    so it is always written explicitly),
 *  - interactive OAuth credentials (persisted automatically to
 *    <config_dir>/credentials.json after first login).
 */
export function renderConfigYml(o: GoLibrespotConfigOptions): string {
  return (
    [
      `device_name: ${JSON.stringify(o.deviceName)}`,
      `device_type: computer`,
      `bitrate: ${o.bitrate}`,
      `audio_backend: pipe`,
      `audio_output_pipe: ${o.fifoPath}`,
      `audio_output_pipe_format: s16le`,
      `server:`,
      `  enabled: true`,
      `  address: ${o.apiAddress}`,
      `  port: ${o.apiPort}`,
      `credentials:`,
      `  type: interactive`,
      `  interactive:`,
      `    callback_port: ${o.callbackPort}`,
    ].join("\n") + "\n"
  );
}
