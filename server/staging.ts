import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync } from "node:fs";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { createApp } from "./app.js";
import { openDb, atomic } from "./db.js";

export const stagingDatabase = "/var/data/nimclaim-staging.sqlite";
export function stagingConfig(env: NodeJS.ProcessEnv) {
  const origin = env.APP_ORIGIN;
  if (
    !origin ||
    new URL(origin).origin !== origin ||
    !origin.startsWith("https://") ||
    new URL(origin).username ||
    new URL(origin).password
  )
    throw new Error("Staging requires an exact HTTPS APP_ORIGIN");
  if (
    env.NIMCLAIM_STAGING !== "1" ||
    env.NODE_ENV !== "production" ||
    env.NETWORK !== "testnet" ||
    env.SPENDING_ENABLED !== "false" ||
    env.DATABASE_PATH !== stagingDatabase ||
    env.SPENDING_NETWORK ||
    env.RPC_URL ||
    env.RPC_AUTHORIZATION ||
    (env.MAX_PAYMENT_LUNA && env.MAX_PAYMENT_LUNA !== "0") ||
    (env.PAYMENT_FEE_LUNA && env.PAYMENT_FEE_LUNA !== "0")
  )
    throw new Error(
      "Unsafe staging configuration; require production, TESTNET, isolated disk and no spending/RPC",
    );
  const hash = env.STAGING_ORGANISER_PASSWORD_HASH;
  if (!hash || !/^[a-f0-9]{64}:[a-f0-9]{128}$/.test(hash))
    throw new Error("A fresh staging organiser scrypt hash is required");
  return { origin, hash, path: stagingDatabase };
}

// A fresh database is bootstrapped at runtime, never in a build/pre-deploy job.
// Refuse an existing database without the staging marker before any schema write.
export function prepareStagingDatabase(path: string, hash: string) {
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error("Staging database must be a regular file");
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      const marker = probe
        .prepare("SELECT value FROM settings WHERE key='deployment'")
        .get();
      if (marker?.value !== "isolated-testnet-staging-v1")
        throw new Error("Refusing a database not created for isolated staging");
    } finally {
      probe.close();
    }
  }
  const db = openDb(path);
  try {
    atomic(db, () => {
      db.prepare(
        "INSERT OR IGNORE INTO settings VALUES ('deployment','isolated-testnet-staging-v1')",
      ).run();
      const organiser = db
        .prepare("SELECT password_hash FROM organiser WHERE id=1")
        .get();
      if (organiser && organiser.password_hash !== hash)
        throw new Error(
          "Staging credential mismatch; credentials are never overwritten",
        );
      db.prepare("INSERT OR IGNORE INTO organiser VALUES (1,?)").run(hash);
    });
  } finally {
    db.close();
  }
}

// Explicit public gateway surface. Fragments never reach this HTTP boundary.
export function stagingRoute(method: string, path: string) {
  if (method === "GET")
    return (
      path === "/" ||
      /^\/assets\/[a-zA-Z0-9_.-]+$/.test(path) ||
      ["/api/config", "/api/session", "/api/campaigns"].includes(path) ||
      /^\/api\/campaigns\/[a-f0-9-]{36}$/.test(path)
    );
  if (method !== "POST") return false;
  return (
    [
      "/api/login",
      "/api/logout",
      "/api/invitation",
      "/api/challenge",
      "/api/claim",
      "/api/campaigns",
    ].includes(path) ||
    /^\/api\/campaigns\/[a-f0-9-]{36}\/invitations$/.test(path) ||
    /^\/api\/claims\/[a-f0-9-]{36}\/decision$/.test(path)
  );
}
export async function startStaging(config: {
  origin: string;
  hash: string;
  path: string;
  staticDir?: string;
}) {
  prepareStagingDatabase(config.path, config.hash);
  const app = createApp({
    path: config.path,
    origin: config.origin,
    network: "testnet",
    staging: true,
    staticDir: config.staticDir ?? "./dist",
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const backendPort = (app.server.address() as { port: number }).port;
  const gateway = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const deny = () => {
      res.writeHead(404);
      res.end();
    };
    // No decoding, URL normalization, alternate hosts or forwarded-header trust.
    if (
      req.headers.host !== new URL(config.origin).host ||
      !stagingRoute(req.method ?? "", req.url ?? "")
    )
      return deny();
    const headers = { ...req.headers };
    for (const key of Object.keys(headers))
      if (
        key.startsWith("x-forwarded-") ||
        ["forwarded", "connection", "upgrade", "proxy-authorization"].includes(
          key,
        )
      )
        delete headers[key];
    if (["/api/invitation", "/api/challenge", "/api/claim"].includes(req.url!))
      delete headers.cookie;
    const upstream = request(
      {
        host: "127.0.0.1",
        port: backendPort,
        path: req.url,
        method: req.method,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });
  gateway.requestTimeout = app.server.requestTimeout = 15_000;
  gateway.headersTimeout = app.server.headersTimeout = 10_000;
  return {
    ...app,
    gateway,
    async close() {
      gateway.closeAllConnections();
      await new Promise<void>((ok) => gateway.close(() => ok()));
      app.server.closeAllConnections();
      await new Promise<void>((ok) => app.server.close(() => ok()));
      app.db.close();
    },
  };
}
