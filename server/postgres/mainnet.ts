import { fileURLToPath } from "node:url";
import mainnetSchemaContract from "./mainnet-schema-contract.json" with { type: "json" };
import { once } from "node:events";
import type { Pool } from "pg";
import { createPool, neonConnection } from "./db.js";
import { verifySchema } from "./schema.js";
import { verifyRuntimeRole } from "./permissions.js";
import { PostgresStore } from "./store.js";
import { FailoverRpc, HttpRpc, type Rpc } from "../rpc.js";
import { createPostgresApp } from "./app.js";
import { stagingGateway, stagingRoute } from "../staging-gateway.js";

export const mainnetIdentity = {
  network: "mainnet",
  deployment: "isolated-mainnet-claims-v1",
  directory: fileURLToPath(new URL("./mainnet-migrations/", import.meta.url)),
  schemaHash: mainnetSchemaContract.sha256,
};
export function mainnetConfig(env: NodeJS.ProcessEnv, administrative = false) {
  if (
    env.NODE_ENV !== "production" ||
    env.NIMCLAIM_PRODUCTION !== "1" ||
    env.NETWORK !== "mainnet" ||
    env.SPENDING_ENABLED !== "false" ||
    env.MAX_PAYMENT_LUNA !== "0" ||
    env.PAYMENT_FEE_LUNA !== "0" ||
    env.NIMCLAIM_STAGING !== undefined ||
    env.MOBILE_TEST !== undefined ||
    env.NIMCLAIM_MOBILE_TEST !== undefined ||
    env.DATABASE_PATH !== undefined ||
    env.SPENDING_NETWORK !== undefined ||
    env.RPC_URL !== undefined ||
    env.RPC_AUTHORIZATION !== undefined ||
    env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
    Object.keys(env).some((key) =>
      /ORGANISER_PASSWORD|^NIMCLAIM_(TEST|PG_TEST)|^STAGING_/.test(key),
    ) ||
    (!administrative && env.DIRECT_DATABASE_URL !== undefined)
  )
    throw new Error(
      "Unsafe MAINNET claims configuration; spending must remain disabled",
    );
  if (
    env.NIMIQ_READONLY_RPC_URLS !== undefined &&
    env.NIMIQ_READONLY_RPC_URL !== undefined
  )
    throw new Error(
      "Set only NIMIQ_READONLY_RPC_URLS (comma-separated) or the legacy single URL, not both.",
    );
  const rawRpcUrls =
    env.NIMIQ_READONLY_RPC_URLS ?? env.NIMIQ_READONLY_RPC_URL ?? "";
  const readonlyRpcUrls = [
    ...new Set(
      rawRpcUrls
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => {
          try {
            const rpcUrl = new URL(value);
            if (
              rpcUrl.protocol !== "https:" ||
              rpcUrl.username ||
              rpcUrl.password ||
              rpcUrl.hash ||
              rpcUrl.search ||
              rpcUrl.pathname !== "/"
            )
              throw new Error();
            return rpcUrl.origin;
          } catch {
            throw new Error(
              "NIMIQ_READONLY_RPC_URLS must contain HTTPS RPC origins without credentials or paths.",
            );
          }
        }),
    ),
  ];
  let origin: string;
  try {
    const url = new URL(env.APP_ORIGIN ?? "");
    if (
      url.protocol !== "https:" ||
      url.origin !== env.APP_ORIGIN ||
      url.port ||
      url.hostname === "localhost" ||
      url.hostname.includes("staging") ||
      !url.hostname.includes(".") ||
      /^\d[\d.]+$/.test(url.hostname) ||
      url.hostname.includes(":")
    )
      throw new Error();
    origin = url.origin;
  } catch {
    throw new Error("Exact production HTTPS APP_ORIGIN required");
  }
  const runtime = neonConnection(
    administrative ? env.DIRECT_DATABASE_URL : env.DATABASE_URL,
    !administrative,
  );
  // Pin the separately provisioned direct endpoint; never accept the staging project.
  const host = env.PRODUCTION_DATABASE_HOST;
  if (
    !host ||
    !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(host) ||
    host.includes("-pooler.") ||
    host.includes("royal-sunset-b9d4cl7u") ||
    runtime.host !== (administrative ? host : host.replace(".", "-pooler.")) ||
    runtime.database !== "nimclaim_mainnet" ||
    (administrative
      ? runtime.user === "nimclaim_app"
      : runtime.user !== "nimclaim_app")
  )
    throw new Error(
      "Separate pinned MAINNET database and restricted role required",
    );
  return { origin, runtime, readonlyRpcUrls };
}
export function mainnetRoute(method: string, path: string) {
  return (
    stagingRoute(method, path) ||
    (method === "POST" &&
      ["/api/auth/challenge", "/api/auth/verify"].includes(path)) ||
    (method === "POST" &&
      /^\/api\/campaigns\/[a-f0-9-]{36}\/wallet(?:\/challenge)?$/.test(path)) ||
    (method === "POST" &&
      /^\/api\/claims\/[a-f0-9-]{36}\/payment\/verify$/.test(path))
  );
}
// Local test seam accepts only caller-owned pools; environment startup always verifies TLS.
export async function startPostgresMainnet(
  pool: Pool,
  origin: string,
  staticDir = "./dist",
  rpc?: Rpc,
) {
  await verifyRuntimeRole(pool, true);
  await verifySchema(pool, true, mainnetIdentity);
  const server = createPostgresApp(
    new PostgresStore(pool, origin, "mainnet", rpc),
    staticDir,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const gateway = stagingGateway(
    (server.address() as { port: number }).port,
    origin,
    mainnetRoute,
  );
  return {
    server,
    gateway,
    async close() {
      await new Promise<void>((ok) => gateway.close(() => ok()));
      await new Promise<void>((ok) => server.close(() => ok()));
      await pool.end();
    },
  };
}
export async function startMainnetFromEnvironment(env: NodeJS.ProcessEnv) {
  const { origin, runtime, readonlyRpcUrls } = mainnetConfig(env);
  const pool = createPool(runtime);
  try {
    const rpc = readonlyRpcUrls.length
      ? new FailoverRpc(readonlyRpcUrls.map((url) => new HttpRpc(url)))
      : undefined;
    return await startPostgresMainnet(pool, origin, "./dist", rpc);
  } catch (error) {
    await pool.end();
    throw error;
  }
}
