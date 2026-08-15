import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app, service } = await buildApp(config);
const address = await app.listen({ port: config.PORT, host: "0.0.0.0" });
app.log.info(
  { event: "startup", address, nodeEnv: config.NODE_ENV, configuration: service.configStatus() },
  "Liaison is ready",
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  const active = service.database.getActiveCall();
  app.log.warn(
    { event: "shutdown", signal, activeCallId: active?.id ?? null },
    active ? "Shutdown requested while a call is active" : "Shutdown requested",
  );
  await service.shutdown();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
