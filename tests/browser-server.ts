import { createApp } from "../server/app.js";
import { passwordHash } from "../server/crypto.js";
// Test-only process. No production fixtures or real wallet access.
const { server, db } = createApp({
  path: ":memory:",
  origin: `http://localhost:${Number(process.env.NIMCLAIM_TEST_WEB_PORT ?? 5173)}`,
  network: "testnet",
});
db.prepare("INSERT INTO organiser VALUES (1,?)").run(
  passwordHash("browser-test-password"),
);
server.listen(Number(process.env.NIMCLAIM_TEST_API_PORT ?? 3001), "127.0.0.1");
