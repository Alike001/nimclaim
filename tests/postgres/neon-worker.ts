// Synthetic Neon verification only. No migration/bootstrap or wallet operations.
import { approvedConnections, isolatedConfig } from "../../ops/neon-target.js";
import { createPool } from "../../server/postgres/db.js";
import { startPostgresStaging } from "../../server/postgres/staging.js";

let pool;
try {
  pool = createPool(
    isolatedConfig(
      approvedConnections().direct,
      process.env.NIMCLAIM_VERIFY_SCHEMA ?? "",
    ),
  );
  const app = await startPostgresStaging(
    pool,
    "https://nimclaim-verify.invalid",
  );
  app.gateway.listen(0, "127.0.0.1", () =>
    process.send?.({ port: (app.gateway.address() as { port: number }).port }),
  );
  let closing = false;
  process.on("SIGTERM", () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => process.exit(0));
  });
} catch {
  console.error("Synthetic Neon worker refused startup");
  await pool?.end();
  process.exitCode = 1;
}
