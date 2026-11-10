// Test-only child process. Synthetic local Postgres only; never shipped in the staging entry point.
import { createPool } from "../../server/postgres/db.js";
import { startPostgresStaging } from "../../server/postgres/staging.js";
const port = Number(process.env.NIMCLAIM_PG_TEST_PORT);
if (
  !Number.isInteger(port) ||
  port < 1024 ||
  !/^nimclaim_test_[a-z0-9_]+$/.test(process.env.NIMCLAIM_PG_TEST_DB ?? "")
)
  throw new Error("Disposable test target required");
const pool = createPool({
  host: "127.0.0.1",
  port,
  user: "nimclaim_app",
  database: process.env.NIMCLAIM_PG_TEST_DB,
  max: 3,
});
try {
  const { startPostgresMainnet } =
    await import("../../server/postgres/mainnet.js");
  const start =
    process.env.NIMCLAIM_PG_TEST_MAINNET === "1"
      ? startPostgresMainnet
      : startPostgresStaging;
  const app = await start(pool, process.env.NIMCLAIM_PG_TEST_ORIGIN!);
  app.gateway.listen(0, "127.0.0.1", () =>
    process.send?.({
      port: (app.gateway.address() as { port: number }).port,
      backend: (app.server.address() as { port: number }).port,
    }),
  );
  let closing = false;
  process.on("SIGTERM", () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => process.exit(0));
  });
} catch {
  console.error("Disposable Postgres worker startup failed");
  await pool.end();
  process.exitCode = 1;
}
