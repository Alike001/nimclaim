import { stagingConfig, startStaging } from "../server/staging.js";
// Deliberately does not load .env. Render supplies only fresh staging settings.
process.umask(0o077);
const config = stagingConfig(process.env);
const port = Number(process.env.PORT ?? "10000");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const app = await startStaging(config);
app.gateway.listen(port, "0.0.0.0", () =>
  console.log("Isolated TESTNET staging ready; spending disabled"),
);
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => process.exit(0));
  });
