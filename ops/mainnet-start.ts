import { startMainnetFromEnvironment } from "../server/postgres/mainnet.js";
// No .env loading, SQLite import/fallback, credential or driver error logging.
process.umask(0o077);
try {
  const port = Number(process.env.PORT ?? "10000");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  const app = await startMainnetFromEnvironment(process.env);
  app.gateway.listen(port, "0.0.0.0", () =>
    console.log("Isolated Postgres MAINNET claims ready; spending disabled"),
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
    "MAINNET startup refused: check isolated database, migrations, credentials and disabled spending",
  );
  process.exitCode = 1;
}
