import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PostgresStore } from "./store.js";
import {
  ApiError,
  fail,
  tokenSchema,
  tokenBody,
  campaignSchema,
  readJson,
  serveStatic,
  securityHeaders,
} from "../http-contract.js";
import { checkPassword, digest, randomToken } from "../crypto.js";

const disabledGate = {
  enabled: false,
  senderBindingSupported: false,
  reasons: ["Spending is permanently disabled in TESTNET staging."],
};
export function createPostgresApp(store: PostgresStore, staticDir = "./dist") {
  if (
    new URL(store.origin).origin !== store.origin ||
    !store.origin.startsWith("https://")
  )
    throw new Error("Postgres staging requires an exact HTTPS origin");
  const server = createServer(async (req, res) => {
    securityHeaders(res, store.origin);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const path = new URL(req.url ?? "/", store.origin).pathname;
      if (path === "/healthz" && req.method === "GET")
        return send(200, { ready: true });
      if (!path.startsWith("/api/")) return serveStatic(path, res, staticDir);
      if (!["GET", "POST"].includes(req.method ?? ""))
        fail(405, "Method not allowed.");
      if (
        /^\/api\/payments(?:\/|$)/.test(path) ||
        /^\/api\/claims\/[^/]+\/payment(?:\/|$)/.test(path) ||
        /^\/api\/campaigns\/[^/]+\/wallet(?:\/|$)/.test(path)
      )
        fail(403, "Payments are unavailable in staging.");
      await store.rate(path === "/api/login");
      let body: any;
      if (req.method === "POST") {
        if (req.headers.origin !== store.origin)
          fail(403, "Request origin is not allowed.");
        if (req.headers["content-type"]?.split(";")[0] !== "application/json")
          fail(415, "JSON required.");
        body = await readJson(req);
      }
      if (path === "/api/config" && req.method === "GET")
        return send(200, {
          network: "testnet",
          origin: store.origin,
          staging: true,
          mobileTest: false,
        });
      await store.expire();
      const session = /(?:^|;\s*)nimclaim_session=([a-f0-9]{64})(?:;|$)/.exec(
        req.headers.cookie ?? "",
      )?.[1];
      const authorised =
        !!session &&
        (
          await store.read(
            "SELECT hash FROM sessions WHERE hash=$1 AND expires>$2",
            [digest(session), Date.now()],
          )
        ).length > 0;
      if (path === "/api/session" && req.method === "GET")
        return send(200, { authenticated: authorised });
      const cookie = (value: string, age: number) =>
        `nimclaim_session=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${age}; Secure`;
      if (path === "/api/login" && req.method === "POST") {
        const { password } = z
          .object({ password: z.string().min(1).max(256) })
          .strict()
          .parse(body);
        const organiser = (
          await store.read("SELECT password_hash FROM organiser WHERE id=1")
        )[0];
        if (!organiser || !checkPassword(password, organiser.password_hash))
          fail(401, "Invalid organiser credentials.");
        const token = randomToken();
        await store.read("DELETE FROM sessions WHERE expires<=$1", [
          Date.now(),
        ]);
        await store.read("INSERT INTO sessions VALUES ($1,$2)", [
          digest(token),
          Date.now() + 8 * 3600000,
        ]);
        res.setHeader("Set-Cookie", cookie(token, 8 * 3600));
        return send(200, { authenticated: true });
      }
      if (path === "/api/logout" && req.method === "POST") {
        if (session)
          await store.read("DELETE FROM sessions WHERE hash=$1", [
            digest(session),
          ]);
        res.setHeader("Set-Cookie", cookie("", 0));
        return send(200, { authenticated: false });
      }
      if (path === "/api/invitation" && req.method === "POST") {
        const { token } = tokenBody.parse(body);
        const inv = (
          await store.read("SELECT * FROM invitations WHERE token_hash=$1", [
            digest(token),
          ])
        )[0];
        if (!inv) fail(404, "Invitation not found. Check your link.");
        const campaign = (
          await store.read("SELECT * FROM campaigns WHERE id=$1", [
            inv.campaign_id,
          ])
        )[0];
        return send(200, {
          campaign,
          expired: campaign.expires <= Date.now(),
          claim: await store.claimView(
            (
              await store.read("SELECT * FROM claims WHERE invitation_id=$1", [
                inv.id,
              ])
            )[0],
          ),
        });
      }
      if (path === "/api/challenge" && req.method === "POST")
        return send(201, await store.challenge(tokenBody.parse(body).token));
      if (path === "/api/claim" && req.method === "POST") {
        const input = z
          .object({
            token: tokenSchema,
            challengeId: z.string().uuid(),
            publicKey: z.string().regex(/^[a-f0-9]{64}$/i),
            signature: z.string().regex(/^[a-f0-9]{128}$/i),
          })
          .strict()
          .parse(body);
        return send(201, { claim: await store.claim(input) });
      }
      if (!authorised) fail(401, "Sign in as organiser to continue.");
      if (path === "/api/campaigns" && req.method === "GET")
        return send(200, {
          campaigns: await store.read(
            `SELECT c.*,(SELECT count(*) FROM invitations WHERE campaign_id=c.id) AS issued,(SELECT count(*) FROM claims WHERE campaign_id=c.id) AS claimed FROM campaigns c ORDER BY created DESC`,
          ),
        });
      if (path === "/api/campaigns" && req.method === "POST") {
        const input = campaignSchema.parse(body),
          now = Date.now();
        if (input.expires <= now || input.expires > now + 366 * 86400000)
          fail(400, "Expiry must be in the future, within one year.");
        const [whole, fraction = ""] = input.amount.split(".");
        const amount = Number(whole) * 100000 + Number(fraction.padEnd(5, "0"));
        if (!Number.isSafeInteger(amount))
          fail(400, "Amount is outside the safe integer range.");
        const campaign = (
          await store.read(
            "INSERT INTO campaigns VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              randomUUID(),
              input.title,
              input.description,
              amount,
              input.slots,
              input.expires,
              now,
            ],
          )
        )[0];
        return send(201, { campaign });
      }
      const detail = /^\/api\/campaigns\/([a-f0-9-]{36})$/.exec(path);
      if (detail && req.method === "GET") {
        const campaign = (
          await store.read("SELECT * FROM campaigns WHERE id=$1", [detail[1]])
        )[0];
        if (!campaign) fail(404, "Campaign not found.");
        const claims = [];
        for (const claim of await store.read(
          "SELECT * FROM claims WHERE campaign_id=$1 ORDER BY created",
          [detail[1]],
        ))
          claims.push(await store.claimView(claim));
        return send(200, {
          campaign,
          staging: true,
          wallet:
            (
              await store.read(
                "SELECT address,created FROM campaign_wallets WHERE campaign_id=$1",
                [detail[1]],
              )
            )[0] ?? null,
          paymentGate: disabledGate,
          invitations: await store.read(
            "SELECT id,created FROM invitations WHERE campaign_id=$1 ORDER BY created",
            [detail[1]],
          ),
          claims,
        });
      }
      const invite = /^\/api\/campaigns\/([a-f0-9-]{36})\/invitations$/.exec(
        path,
      );
      if (invite && req.method === "POST") {
        z.object({}).strict().parse(body);
        return send(201, await store.issue(invite[1]));
      }
      const decision = /^\/api\/claims\/([a-f0-9-]{36})\/decision$/.exec(path);
      if (decision && req.method === "POST") {
        const { decision: status } = z
          .object({ decision: z.enum(["payment-ready", "rejected"]) })
          .strict()
          .parse(body);
        return send(200, { claim: await store.decide(decision[1], status) });
      }
      fail(404, "Endpoint not found.");
    } catch (error) {
      if (error instanceof ApiError)
        send(error.status, { error: error.message });
      else if (error instanceof z.ZodError)
        send(400, {
          error: "Invalid input. Check the required fields and formats.",
        });
      else if (
        ["23505", "40001", "40P01", "55P03"].includes(
          (error as { code?: string })?.code ?? "",
        )
      )
        send(409, {
          error:
            "Request conflicts with another operation. Refresh before retrying.",
        });
      else {
        console.error("Postgres request unavailable");
        send(503, {
          error:
            "Service temporarily unavailable. Refresh status before retrying.",
        });
      }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
