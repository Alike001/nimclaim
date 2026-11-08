import type { Pool } from "pg";
import { once } from "node:events";
import { neonConnection, createPool, migrate, bootstrap } from "./db.js";
import { createPostgresApp } from "./app.js";
import { PostgresStore } from "./store.js";
import { stagingGateway } from "../staging-gateway.js";

export function postgresStagingConfig(env: NodeJS.ProcessEnv) {
  const origin = env.APP_ORIGIN;
  if (
    !origin ||
    !origin.startsWith("https://") ||
    new URL(origin).origin !== origin ||
    new URL(origin).username ||
    new URL(origin).password
  )
    throw new Error("Staging requires an exact HTTPS APP_ORIGIN");
  if (
    env.NODE_ENV !== "production" ||
    env.NIMCLAIM_STAGING !== "1" ||
    env.NETWORK !== "testnet" ||
    env.SPENDING_ENABLED !== "false" ||
    env.DATABASE_PATH ||
    env.SPENDING_NETWORK ||
    env.RPC_URL ||
    env.RPC_AUTHORIZATION ||
    (env.MAX_PAYMENT_LUNA && env.MAX_PAYMENT_LUNA !== "0") ||
    (env.PAYMENT_FEE_LUNA && env.PAYMENT_FEE_LUNA !== "0")
  )
    throw new Error("Unsafe Postgres TESTNET staging configuration");
  const hash = env.STAGING_ORGANISER_PASSWORD_HASH;
  if (!hash || !/^[a-f0-9]{64}:[a-f0-9]{128}$/.test(hash))
    throw new Error("Fresh staging organiser hash required");
  const runtime = neonConnection(env.DATABASE_URL, true),
    direct = neonConnection(env.DIRECT_DATABASE_URL, false);
  if (
    String(runtime.host).replace("-pooler.", ".") !== direct.host ||
    runtime.database !== direct.database
  )
    throw new Error(
      "Pooled and direct URLs must target the same isolated Neon database",
    );
  return { origin, hash, runtime, direct };
}
// Separate seam for real local PostgreSQL integration tests. Production always uses verified Neon TLS.
export async function startPostgresStaging(
  pool: Pool,
  origin: string,
  staticDir = "./dist",
) {
  const settings = (await pool.query("SELECT key,value FROM settings")).rows;
  if (
    !settings.some((r) => r.key === "network" && r.value === "testnet") ||
    !settings.some(
      (r) =>
        r.key === "deployment" &&
        r.value === "isolated-neon-testnet-staging-v1",
    )
  )
    throw new Error("Wrong staging database identity");
  if (!(await pool.query("SELECT id FROM organiser WHERE id=1")).rowCount)
    throw new Error("Staging organiser missing");
  const server = createPostgresApp(new PostgresStore(pool, origin), staticDir);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const gateway = stagingGateway(
    (server.address() as { port: number }).port,
    origin,
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
export async function startFromEnvironment(env: NodeJS.ProcessEnv) {
  const config = postgresStagingConfig(env);
  const migrationPool = createPool(config.direct);
  try {
    await migrate(migrationPool);
    await bootstrap(migrationPool, config.hash);
  } finally {
    await migrationPool.end();
  }
  const pool = createPool(config.runtime);
  try {
    return await startPostgresStaging(pool, config.origin);
  } catch (error) {
    await pool.end();
    throw error;
  }
}
