import type { Pool } from "pg";
import { once } from "node:events";
import { neonConnection, createPool } from "./db.js";
import { verifySchema } from "./schema.js";
import { verifyRuntimeRole } from "./permissions.js";
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
    env.DIRECT_DATABASE_URL ||
    env.STAGING_ORGANISER_PASSWORD_HASH ||
    env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
    (env.MAX_PAYMENT_LUNA && env.MAX_PAYMENT_LUNA !== "0") ||
    (env.PAYMENT_FEE_LUNA && env.PAYMENT_FEE_LUNA !== "0")
  )
    throw new Error("Unsafe Postgres TESTNET staging configuration");
  const runtime = neonConnection(env.DATABASE_URL, true);
  if (
    runtime.user !== "nimclaim_app" ||
    runtime.database !== "nimclaim" ||
    runtime.host !==
      "ep-royal-sunset-b9d4cl7u-pooler.c-7.eu-central-1.aws.neon.tech"
  )
    throw new Error(
      "Approved isolated database and restricted runtime role required",
    );
  return { origin, runtime };
}
// Separate seam for real local PostgreSQL integration tests. Production always uses verified Neon TLS.
export async function startPostgresStaging(
  pool: Pool,
  origin: string,
  staticDir = "./dist",
) {
  await verifyRuntimeRole(pool);
  await verifySchema(pool);
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
  const pool = createPool(config.runtime);
  try {
    return await startPostgresStaging(pool, config.origin);
  } catch (error) {
    await pool.end();
    throw error;
  }
}
