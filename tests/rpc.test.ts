import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { HttpRpc } from "../server/rpc.js";

test("RPC adapter only permits read methods and parses official result.data envelopes", async (t) => {
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    methods.push(input.method);
    assert.deepEqual(input.params, []);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: input.id,
        result: { data: "TestAlbatross", metadata: null },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((ok) => server.close(() => ok())));
  const rpc = new HttpRpc(
    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  );
  assert.equal(await rpc.call("getNetworkId", []), "TestAlbatross");
  for (const method of [
    "sendBasicTransaction",
    "sendRawTransaction",
    "pushTransaction",
    "listAccounts",
    "createAccount",
  ])
    await assert.rejects(rpc.call(method, []), /read-only/);
  assert.deepEqual(methods, ["getNetworkId"]);
  assert.throws(() => new HttpRpc("http://public.example"), /HTTPS/);
  assert.throws(
    () => new HttpRpc("https://user:secret@rpc.example"),
    /credentials/,
  );
});

test("RPC timeout and missing/error envelopes fail closed", async (t) => {
  let mode: "timeout" | "error" | "bad" = "timeout";
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    if (mode === "timeout") return;
    res.end(
      JSON.stringify(
        mode === "error"
          ? { jsonrpc: "2.0", id: input.id, error: { code: -1 } }
          : { jsonrpc: "2.0", id: input.id, result: { value: true } },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((ok) => server.close(() => ok()));
  });
  const rpc = new HttpRpc(
    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    undefined,
    50,
  );
  await assert.rejects(rpc.call("getNetworkId", []));
  mode = "error";
  await assert.rejects(rpc.call("getNetworkId", []));
  mode = "bad";
  await assert.rejects(rpc.call("getNetworkId", []));
});
