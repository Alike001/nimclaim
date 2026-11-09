// Explicit read-only preflight for a future privately provisioned runtime login.
import { parseEnv } from "node:util";
import { protectedLocalFile } from "./staging-admin.js";
import { verifyConnection } from "./neon-target.js";
import { postgresStagingConfig } from "../server/postgres/staging.js";
import { createPool } from "../server/postgres/db.js";
import { verifyRuntimeRole } from "../server/postgres/permissions.js";
import { verifySchema } from "../server/postgres/schema.js";

let pool;
try {
  if (process.argv.length !== 3)
    throw new Error("Protected runtime file required");
  const env = parseEnv(protectedLocalFile(process.argv[2]));
  const { runtime } = postgresStagingConfig({
    ...env,
    NODE_ENV: "production",
    NIMCLAIM_STAGING: "1",
    NETWORK: "testnet",
    SPENDING_ENABLED: "false",
    MAX_PAYMENT_LUNA: "0",
    PAYMENT_FEE_LUNA: "0",
    APP_ORIGIN: "https://nimclaim-preflight.invalid",
    NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
  });
  pool = createPool(runtime);
  await verifyConnection(pool, runtime);
  await verifyRuntimeRole(pool);
  await verifySchema(pool);
  console.log(
    "PASS restricted pooled runtime TLS, privileges, reviewed TESTNET schema and existing organiser; read-only preflight",
  );
} catch {
  console.error(
    "Runtime preflight refused; no credentials or driver details logged",
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
