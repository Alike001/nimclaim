import { createApp } from "./app.js";
const network = process.env.NETWORK ?? "testnet";
if (network !== "testnet" && network !== "mainnet")
  throw new Error("NETWORK must be testnet or mainnet");
const origin = process.env.APP_ORIGIN ?? "http://localhost:5173";
if (process.env.NODE_ENV === "production" && !origin.startsWith("https://"))
  throw new Error("Production requires an HTTPS APP_ORIGIN");
const { server, db } = createApp({
  path: process.env.DATABASE_PATH ?? "./data/nimclaim.sqlite",
  origin,
  network,
  staticDir: process.env.NODE_ENV === "production" ? "./dist" : undefined,
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(
  Number(process.env.PORT ?? 3001),
  process.env.HOST ?? "127.0.0.1",
  () => {
    const address = server.address();
    console.log(
      `NimClaim API port ${typeof address === "object" && address ? address.port : "unknown"}; expected origin ${origin}; network ${network}`,
    );
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
