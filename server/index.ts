import { HttpRpc } from "./rpc.js";
import { createApp } from "./app.js";
const network = process.env.NETWORK ?? "testnet";
if (network !== "testnet" && network !== "mainnet")
  throw new Error("NETWORK must be testnet or mainnet");
const origin = process.env.APP_ORIGIN ?? "http://localhost:5173";
if (process.env.NODE_ENV === "production" && !origin.startsWith("https://"))
  throw new Error("Production requires an HTTPS APP_ORIGIN");
function integerEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new Error(`${name} must be a nonnegative safe integer`);
  return Number(raw);
}
const spendingNetwork = process.env.SPENDING_NETWORK;
if (
  spendingNetwork &&
  spendingNetwork !== "testnet" &&
  spendingNetwork !== "mainnet"
)
  throw new Error("Invalid SPENDING_NETWORK");
if (
  process.env.SPENDING_ENABLED &&
  !["true", "false"].includes(process.env.SPENDING_ENABLED)
)
  throw new Error("SPENDING_ENABLED must be true or false");
const { server, db } = createApp({
  path: process.env.DATABASE_PATH ?? "./data/nimclaim.sqlite",
  origin,
  network,
  mobileTest: process.env.NIMCLAIM_MOBILE_TEST === "1",
  payments: {
    enabled: process.env.SPENDING_ENABLED === "true",
    spendingNetwork:
      spendingNetwork === "mainnet"
        ? "mainnet"
        : spendingNetwork === "testnet"
          ? "testnet"
          : undefined,
    maxLuna: integerEnv("MAX_PAYMENT_LUNA", 0),
    feeLuna: integerEnv("PAYMENT_FEE_LUNA", 0),
    rpc: process.env.RPC_URL
      ? new HttpRpc(process.env.RPC_URL, process.env.RPC_AUTHORIZATION)
      : undefined,
    // No selected-sender assurance adapter exists in the official SDK. Never infer it from signatures or listAccounts.
  },
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
