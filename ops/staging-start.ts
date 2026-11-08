import { startFromEnvironment } from "../server/postgres/staging.js";
// No .env loading, SQLite import/fallback, credential or driver error logging.
process.umask(0o077);
try {
  const port = Number(process.env.PORT ?? "10000");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  const app = await startFromEnvironment(process.env);
  app.gateway.listen(port, "0.0.0.0", () =>
    console.log("Isolated Postgres TESTNET staging ready; spending disabled"),
  );
  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      void app.close().then(() => process.exit(0));
    });
} catch {
  console.error(
    "Staging startup refused: check database, migrations and required TESTNET configuration",
  );
  process.exitCode = 1;
}
