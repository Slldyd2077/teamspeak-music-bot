import type { Server } from "node:http";
import { closeEmbeddedApi, getSafeApiStartupError, startEmbeddedApi, type ApiChildMessage, type ApiProvider } from "./api-server-runtime.js";

const providerArg = process.argv[2];
const port = Number(process.argv[3]);
if ((providerArg !== "netease" && providerArg !== "qq") || !Number.isInteger(port) || port < 1 || port > 65535 || !process.send) process.exit(1);
const provider = providerArg as ApiProvider;
let server: Server | null = null;
let stopping = false;

function shutdown(exitCode = 0): void {
  if (stopping) return;
  stopping = true;
  // Also covers a legacy auto-start listener and an import still in flight.
  const deadline = setTimeout(() => process.exit(exitCode), 1000);
  closeEmbeddedApi(server).finally(() => { clearTimeout(deadline); process.exit(exitCode); });
}

function fail(error: unknown): void {
  if (stopping) return;
  const message: ApiChildMessage = { type: "error", provider, port, ...getSafeApiStartupError(error) };
  if (!process.connected) { shutdown(1); return; }
  try { process.send!(message, () => shutdown(1)); }
  catch { shutdown(1); }
}

process.on("message", (message: unknown) => {
  if (message && typeof message === "object" && (message as { type?: unknown }).type === "stop") shutdown();
});
process.on("disconnect", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

startEmbeddedApi(provider, port).then((runtime) => {
  server = runtime.server;
  if (stopping || !process.connected) { shutdown(); return; }
  server?.on("error", fail);
  const message: ApiChildMessage = { type: "ready", provider, port };
  try { process.send!(message, (error) => { if (error) shutdown(1); }); }
  catch { shutdown(1); }
}).catch(fail);
