import { createApp } from "../server/app.js";
import { passwordHash } from "../server/crypto.js";
import { once } from "node:events";
// Test-only process. No production fixtures or real wallet access.
export async function startBrowserServer(
  network: "testnet" | "mainnet" = "testnet",
) {
  const { server, db } = createApp({
    path: ":memory:",
    origin: `http://localhost:${Number(process.env.NIMCLAIM_TEST_WEB_PORT ?? 5173)}`,
    network,
  });
  db.prepare("INSERT INTO organiser VALUES (1,?)").run(
    passwordHash("browser-test-password"),
  );
  try {
    server.listen(
      Number(process.env.NIMCLAIM_TEST_API_PORT ?? 3001),
      "127.0.0.1",
    );
    await once(server, "listening");
  } catch (error) {
    db.close();
    throw error;
  }
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    db.close();
  };
}
