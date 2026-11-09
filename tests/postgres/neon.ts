// Read-only continuation of the historical hosted write harness. The old
// initialize/test modes are deliberately unavailable; admin tasks are explicit.
import {
  approvedConnections,
  verifyConnection,
} from "../../ops/neon-target.js";
import { createPool } from "../../server/postgres/db.js";
import { verifySchema } from "../../server/postgres/schema.js";
import type { Pool } from "pg";

const pools: Pool[] = [];
try {
  if (process.argv.length !== 2)
    throw new Error("Read-only check takes no arguments");
  const config = approvedConnections();
  for (const key of ["direct", "runtime"] as const) {
    const pool = createPool(config[key]);
    pools.push(pool);
    await verifyConnection(pool, config[key]);
    await verifySchema(pool, false);
  }
  console.log(
    "PASS hosted direct/pooled verified TLS; reviewed schema and TESTNET identity; read-only checks only",
  );
  console.log(
    "Restricted hosted runtime-role acceptance is not exercised by this owner-only check",
  );
} catch {
  console.error("Hosted read-only verification refused; details suppressed");
  process.exitCode = 1;
} finally {
  for (const pool of pools) await pool.end();
}
