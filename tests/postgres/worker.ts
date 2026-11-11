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
  let app;
  if (process.env.NIMCLAIM_PG_TEST_MAINNET === "1") {
    const rpc =
      process.env.NIMCLAIM_PG_TEST_RPC === "1"
        ? (() => {
            const hash = process.env.NIMCLAIM_PG_TEST_RPC_HASH!;
            const sender = process.env.NIMCLAIM_PG_TEST_RPC_SENDER!;
            const recipient = process.env.NIMCLAIM_PG_TEST_RPC_RECIPIENT!;
            const amount = Number(process.env.NIMCLAIM_PG_TEST_RPC_AMOUNT);
            const tx = {
              hash,
              from: sender,
              to: recipient,
              fromType: 0,
              toType: 0,
              value: amount,
              fee: 1000,
              networkId: 24,
              validityStartHeight: 100,
              flags: 0,
              senderData: "",
              recipientData: "",
              blockNumber: 101,
              executionResult: true,
              proof: "00",
            };
            return {
              async call(method: string, params: unknown[]) {
                if (method === "isConsensusEstablished") return true;
                if (method === "getBlockNumber") return 200;
                if (method === "getTransactionByHash") return tx;
                if (method === "getMacroBlockAfter") return 128;
                if (method === "getBlockByNumber" && params[0] === 200)
                  return {
                    number: 200,
                    hash: "d".repeat(64),
                    network: "MainAlbatross",
                  };
                if (method === "getBlockByNumber" && params[0] === 128)
                  return {
                    number: 128,
                    hash: "b".repeat(64),
                    network: "MainAlbatross",
                    type: "macro",
                    justification: { sig: "SYNTHETIC_TEST_ONLY" },
                  };
                if (method === "getBlockByNumber" && params[0] === 101)
                  return {
                    number: 101,
                    hash: "c".repeat(64),
                    network: "MainAlbatross",
                    type: "micro",
                    transactions: [tx],
                  };
                throw new Error("Unexpected synthetic MAINNET RPC method");
              },
            };
          })()
        : undefined;
    app = await startPostgresMainnet(
      pool,
      process.env.NIMCLAIM_PG_TEST_ORIGIN!,
      "./dist",
      rpc,
    );
  } else {
    app = await startPostgresStaging(
      pool,
      process.env.NIMCLAIM_PG_TEST_ORIGIN!,
    );
  }
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
