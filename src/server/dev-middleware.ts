import type { FastifyInstance } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
// Type-only side-effect import: brings in middie's `FastifyInstance.use` declaration merging
// without emitting a runtime import, since middie itself is loaded dynamically below.
import type {} from "@fastify/middie";

/**
 * The deliberately small surface used from Vite's dev server, mirroring the narrow-interface
 * approach taken with the Twilio client. Vite is a development-only dependency and is not part of
 * the production server build, so the server project describes what it needs rather than depending
 * on Vite's full type surface.
 */
interface ViteDevServerLike {
  middlewares: (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void;
  close: () => Promise<void>;
}

/** Paths owned by Fastify. Everything else falls through to Vite so the SPA can be served in dev. */
function isServerRoute(url: string): boolean {
  return url.startsWith("/api/") || url.startsWith("/webhooks/") || url === "/health" || url === "/ready";
}

/**
 * Mounts Vite as development middleware. Imported dynamically so a production process never loads
 * the dev dependency, and registered after Fastify's own routes so server paths always win.
 */
export async function attachViteDevMiddleware(app: FastifyInstance): Promise<void> {
  const middie = await import("@fastify/middie");
  await app.register(middie.default);
  const { createServer } = await import("vite");
  const vite = (await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  })) as unknown as ViteDevServerLike;
  const handle = (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void): void => {
    if (isServerRoute(request.url ?? "")) return next();
    return vite.middlewares(request, response, next);
  };
  app.use(handle);
  app.addHook("onClose", async () => {
    await vite.close();
  });
}
