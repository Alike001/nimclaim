import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { z } from "zod";
import { openDb, atomic } from "./db.js";
import { migratePayments } from "./payment-schema.js";
import {
  Payments,
  PaymentError,
  proofSchema,
  type PaymentOptions,
} from "./payments.js";
import { hashSchema } from "./rpc.js";
import { checkPassword, digest, randomToken, verifyOwner } from "./crypto.js";

type Row = Record<string, any>; // SQLite rows are validated at the API boundary.
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new ApiError(status, message);
};
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const tokenBody = z.object({ token: tokenSchema }).strict();
const campaignSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(2000),
    amount: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,5})?$/)
      .refine((v) => Number(v) > 0),
    slots: z.number().int().min(1).max(1000),
    expires: z.number().int(),
  })
  .strict();
export interface Config {
  path: string;
  origin: string;
  network: "testnet" | "mainnet";
  now?: () => number;
  staticDir?: string;
  payments?: Omit<PaymentOptions, "origin" | "network" | "now">;
}
export function createApp(config: Config) {
  if (new URL(config.origin).origin !== config.origin)
    throw new Error(
      "APP_ORIGIN must be an exact origin without trailing slash",
    );
  const db = openDb(config.path),
    now = config.now ?? Date.now;
  const storedNetwork = db
    .prepare("SELECT value FROM settings WHERE key='network'")
    .get();
  if (storedNetwork && storedNetwork.value !== config.network) {
    db.close();
    throw new Error(
      "Database network mismatch. Use a separate database for each network.",
    );
  }
  db.prepare("INSERT OR IGNORE INTO settings VALUES ('network',?)").run(
    config.network,
  );
  migratePayments(db);
  const payments = new Payments(db, {
    ...config.payments,
    origin: config.origin,
    network: config.network,
    now,
  });
  const get = (sql: string, ...args: any[]) =>
    db.prepare(sql).get(...args) as Row | undefined;
  const all = (sql: string, ...args: any[]) =>
    db.prepare(sql).all(...args) as Row[];
  const run = (sql: string, ...args: any[]) => db.prepare(sql).run(...args);
  const event = (id: string, status: string, at = now()) =>
    run(
      "INSERT INTO events (claim_id,status,at) VALUES (?,?,?)",
      id,
      status,
      at,
    );
  function expire() {
    atomic(db, () => {
      const rows = all(
        "SELECT claims.id,campaigns.expires FROM claims JOIN campaigns ON campaigns.id=claims.campaign_id WHERE claims.status='pending' AND campaigns.expires<=?",
        now(),
      );
      for (const row of rows) {
        run(
          "UPDATE claims SET status='expired' WHERE id=? AND status='pending'",
          row.id,
        );
        event(row.id, "expired", row.expires);
      }
    });
  }
  function invitation(token: string) {
    const inv = get(
      "SELECT invitations.*, campaigns.expires FROM invitations JOIN campaigns ON campaigns.id=invitations.campaign_id WHERE token_hash=?",
      digest(token),
    );
    if (!inv) fail(404, "Invitation not found. Check your link.");
    return inv!;
  }
  function usable(inv: Row) {
    if (inv.expires <= now()) fail(410, "This invitation has expired.");
    if (get("SELECT id FROM claims WHERE invitation_id=?", inv.id))
      fail(409, "This invitation has already been used.");
  }
  function claimView(claim: Row | undefined) {
    if (!claim) return null;
    return {
      id: claim.id,
      address: claim.address,
      status: claim.status,
      created: claim.created,
      payment: payments.view(claim.id),
      history: all(
        "SELECT status,at FROM events WHERE claim_id=? ORDER BY id",
        claim.id,
      ),
    };
  }
  const rate = new Map<string, { count: number; until: number }>();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (config.origin.startsWith("https:"))
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", config.origin),
        path = url.pathname;
      if (!path.startsWith("/api/"))
        return serveStatic(path, res, config.staticDir);
      if (!["GET", "POST"].includes(req.method ?? ""))
        fail(405, "Method not allowed.");
      // Never trust forwarded IP headers. Single-process development rate limit.
      for (const [key, value] of rate)
        if (value.until <= now()) rate.delete(key);
      const rateKey = `${req.socket.remoteAddress}:${path === "/api/login" ? "login" : "api"}`;
      const bucket = rate.get(rateKey) ?? { count: 0, until: now() + 60_000 };
      if (++bucket.count > (path === "/api/login" ? 10 : 180))
        fail(429, "Too many requests. Try again in a minute.");
      rate.set(rateKey, bucket);
      let body: any;
      if (req.method === "POST") {
        if (req.headers.origin !== config.origin)
          fail(403, "Request origin is not allowed.");
        if (req.headers["content-type"]?.split(";")[0] !== "application/json")
          fail(415, "JSON required.");
        body = await readJson(req);
      }
      expire();
      if (path === "/api/config" && req.method === "GET")
        return send(200, {
          network: config.network,
          origin: config.origin,
          payments: payments.gate(),
        });
      const session = /(?:^|;\s*)nimclaim_session=([a-f0-9]{64})(?:;|$)/.exec(
        req.headers.cookie ?? "",
      )?.[1];
      const authorised =
        session &&
        get(
          "SELECT hash FROM sessions WHERE hash=? AND expires>?",
          digest(session),
          now(),
        );
      if (path === "/api/session" && req.method === "GET")
        return send(200, { authenticated: !!authorised });
      const cookie = (value: string, age: number) =>
        `nimclaim_session=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${age}${config.origin.startsWith("https:") ? "; Secure" : ""}`;
      if (path === "/api/login" && req.method === "POST") {
        const { password } = z
          .object({ password: z.string().min(1).max(256) })
          .strict()
          .parse(body);
        const organiser = get("SELECT password_hash FROM organiser WHERE id=1");
        if (!organiser || !checkPassword(password, organiser.password_hash))
          fail(
            401,
            "Invalid organiser credentials. Run setup if this is a new installation.",
          );
        const token = randomToken();
        run("DELETE FROM sessions WHERE expires<=?", now());
        run(
          "INSERT INTO sessions VALUES (?,?)",
          digest(token),
          now() + 8 * 3600_000,
        );
        res.setHeader("Set-Cookie", cookie(token, 8 * 3600));
        return send(200, { authenticated: true });
      }
      if (path === "/api/logout" && req.method === "POST") {
        if (session) run("DELETE FROM sessions WHERE hash=?", digest(session));
        res.setHeader("Set-Cookie", cookie("", 0));
        return send(200, { authenticated: false });
      }
      if (path === "/api/invitation" && req.method === "POST") {
        const { token } = tokenBody.parse(body),
          inv = invitation(token);
        return send(200, {
          campaign: get("SELECT * FROM campaigns WHERE id=?", inv.campaign_id),
          expired: inv.expires <= now(),
          claim: claimView(
            get("SELECT * FROM claims WHERE invitation_id=?", inv.id),
          ),
        });
      }
      if (path === "/api/challenge" && req.method === "POST") {
        const { token } = tokenBody.parse(body);
        const result = atomic(db, () => {
          const inv = invitation(token);
          usable(inv);
          run("DELETE FROM challenges WHERE expires<=? AND used=0", now());
          // Invalidate prior unconsumed challenges for this invitation, bounding storage and replay surface.
          run(
            "DELETE FROM challenges WHERE invitation_id=? AND used=0",
            inv.id,
          );
          const id = randomUUID(),
            expires = Math.min(now() + 5 * 60_000, inv.expires);
          const campaign = get(
            "SELECT * FROM campaigns WHERE id=?",
            inv.campaign_id,
          )!;
          const message = JSON.stringify({
            domain: "NimClaim/claim/v1",
            purpose: "Request a contributor reward; no payment or transaction",
            origin: config.origin,
            network: config.network,
            campaign: inv.campaign_id,
            invitation: inv.id,
            tokenHash: digest(token),
            amountLuna: campaign.amount,
            nonce: randomToken(),
            expires,
          });
          run(
            "INSERT INTO challenges (id,invitation_id,message,expires) VALUES (?,?,?,?)",
            id,
            inv.id,
            message,
            expires,
          );
          return { id, message, expires, network: config.network };
        });
        return send(201, result);
      }
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
        const result = atomic(db, () => {
          const inv = invitation(input.token);
          usable(inv);
          const challenge = get(
            "SELECT * FROM challenges WHERE id=? AND invitation_id=?",
            input.challengeId,
            inv.id,
          );
          if (!challenge || challenge.used || challenge.expires <= now())
            fail(
              409,
              "Signing request is expired or already used. Request a new one.",
            );
          const binding = JSON.parse(challenge!.message);
          if (
            binding.origin !== config.origin ||
            binding.network !== config.network
          )
            fail(
              409,
              "Signing request belongs to a different origin or network. Request a new one.",
            );
          const address = verifyOwner(
            challenge!.message,
            input.publicKey,
            input.signature,
          );
          if (!address) fail(401, "Wallet signature is invalid.");
          if (
            get(
              "SELECT id FROM claims WHERE campaign_id=? AND address=?",
              inv.campaign_id,
              address,
            )
          )
            fail(
              409,
              "This wallet has already claimed a reward in this campaign.",
            );
          const id = randomUUID();
          run(
            "INSERT INTO claims VALUES (?,?,?,?,?,?,?,'pending',?)",
            id,
            inv.id,
            inv.campaign_id,
            address,
            input.publicKey,
            input.signature,
            challenge!.id,
            now(),
          );
          run(
            "UPDATE challenges SET used=1 WHERE id=? AND used=0",
            challenge!.id,
          );
          event(id, "pending");
          return claimView(get("SELECT * FROM claims WHERE id=?", id));
        });
        return send(201, { claim: result });
      }
      if (!authorised) fail(401, "Sign in as organiser to continue.");
      const walletRoute =
        /^\/api\/campaigns\/([a-f0-9-]{36})\/wallet(?:\/(challenge))?$/.exec(
          path,
        );
      if (walletRoute && req.method === "POST") {
        const result = walletRoute[2]
          ? (z.object({}).strict().parse(body),
            payments.challenge(walletRoute[1], digest(session!)))
          : payments.bind(
              walletRoute[1],
              digest(session!),
              proofSchema.parse(body),
            );
        return send(walletRoute[2] ? 201 : 200, result);
      }
      const paymentRoute =
        /^\/api\/claims\/([a-f0-9-]{36})\/payment\/(review|challenge|reserve)$/.exec(
          path,
        );
      if (paymentRoute && req.method === "POST") {
        const [, claimId, action] = paymentRoute;
        if (action === "reserve")
          return send(
            201,
            await payments.reserve(
              claimId,
              digest(session!),
              proofSchema.parse(body),
            ),
          );
        z.object({}).strict().parse(body);
        const review = payments.review(claimId);
        return send(
          action === "review" ? 200 : 201,
          action === "review"
            ? review
            : payments.challenge(review.campaignId, digest(session!), claimId),
        );
      }
      const attemptRoute =
        /^\/api\/payments\/([a-f0-9-]{36})\/(dispatch|outcome|reconcile)$/.exec(
          path,
        );
      if (attemptRoute && req.method === "POST") {
        const [, id, action] = attemptRoute;
        if (action === "dispatch") {
          const { permit } = z
            .object({ permit: tokenSchema })
            .strict()
            .parse(body);
          return send(200, payments.dispatch(id, permit));
        }
        if (action === "outcome") {
          const input = z
            .object({
              outcome: z.enum(["hash", "cancelled", "error", "timeout"]),
              hash: hashSchema.optional(),
            })
            .strict()
            .refine((v) => v.outcome !== "hash" || !!v.hash)
            .parse(body);
          return send(200, payments.outcome(id, input.outcome, input.hash));
        }
        const { hash } = z
          .object({ hash: hashSchema.optional() })
          .strict()
          .parse(body);
        return send(200, await payments.reconcile(id, hash));
      }
      if (path === "/api/campaigns" && req.method === "GET")
        return send(200, {
          campaigns: all(
            `SELECT campaigns.*, (SELECT COUNT(*) FROM invitations WHERE campaign_id=campaigns.id) AS issued, (SELECT COUNT(*) FROM claims WHERE campaign_id=campaigns.id) AS claimed FROM campaigns ORDER BY created DESC`,
          ),
        });
      if (path === "/api/campaigns" && req.method === "POST") {
        const input = campaignSchema.parse(body);
        if (input.expires <= now() || input.expires > now() + 366 * 86400_000)
          fail(400, "Expiry must be in the future, within one year.");
        const [whole, fraction = ""] = input.amount.split(".");
        const amount =
          Number(whole) * 100_000 + Number(fraction.padEnd(5, "0"));
        const id = randomUUID();
        run(
          "INSERT INTO campaigns VALUES (?,?,?,?,?,?,?)",
          id,
          input.title,
          input.description,
          amount,
          input.slots,
          input.expires,
          now(),
        );
        return send(201, {
          campaign: get("SELECT * FROM campaigns WHERE id=?", id),
        });
      }
      const detail = /^\/api\/campaigns\/([a-f0-9-]{36})$/.exec(path);
      if (detail && req.method === "GET") {
        const campaign = get("SELECT * FROM campaigns WHERE id=?", detail[1]);
        if (!campaign) fail(404, "Campaign not found.");
        return send(200, {
          campaign,
          wallet: payments.wallet(detail[1]),
          paymentGate: payments.gate(),
          invitations: all(
            "SELECT id,created FROM invitations WHERE campaign_id=? ORDER BY created",
            detail[1],
          ),
          claims: all(
            "SELECT * FROM claims WHERE campaign_id=? ORDER BY created",
            detail[1],
          ).map(claimView),
        });
      }
      const invite = /^\/api\/campaigns\/([a-f0-9-]{36})\/invitations$/.exec(
        path,
      );
      if (invite && req.method === "POST") {
        z.object({}).strict().parse(body);
        const result = atomic(db, () => {
          const campaign = get("SELECT * FROM campaigns WHERE id=?", invite[1]);
          if (!campaign) fail(404, "Campaign not found.");
          if (campaign!.expires <= now()) fail(410, "Campaign has expired.");
          const count = get(
            "SELECT COUNT(*) AS n FROM invitations WHERE campaign_id=?",
            invite[1],
          )!.n;
          if (count >= campaign!.slots)
            fail(409, "All reward slots have an invitation.");
          const token = randomToken(),
            id = randomUUID();
          run(
            "INSERT INTO invitations VALUES (?,?,?,?)",
            id,
            invite[1],
            digest(token),
            now(),
          );
          return { id, url: `${config.origin}/#claim=${token}` };
        });
        return send(201, result);
      }
      const decision = /^\/api\/claims\/([a-f0-9-]{36})\/decision$/.exec(path);
      if (decision && req.method === "POST") {
        const { decision: status } = z
          .object({ decision: z.enum(["payment-ready", "rejected"]) })
          .strict()
          .parse(body);
        const result = atomic(db, () => {
          const claim = get("SELECT * FROM claims WHERE id=?", decision[1]);
          if (!claim) fail(404, "Claim not found.");
          const campaign = get(
            "SELECT expires FROM campaigns WHERE id=?",
            claim!.campaign_id,
          )!;
          if (claim!.status !== "pending" || campaign.expires <= now())
            fail(409, "Only an unexpired pending claim can be reviewed.");
          const update = run(
            "UPDATE claims SET status=? WHERE id=? AND status='pending'",
            status,
            decision[1],
          );
          if (Number(update.changes) !== 1)
            fail(409, "Claim already reviewed.");
          event(decision[1], status);
          return claimView(get("SELECT * FROM claims WHERE id=?", decision[1]));
        });
        return send(200, { claim: result });
      }
      fail(404, "Endpoint not found.");
    } catch (error) {
      if (error instanceof z.ZodError)
        send(400, {
          error: "Invalid input. Check the required fields and formats.",
        });
      else if (error instanceof ApiError || error instanceof PaymentError)
        send(error.status, { error: error.message });
      else {
        console.error(
          "API failure:",
          error instanceof Error ? error.message : "Unknown",
        );
        send(500, { error: "Server could not complete the request." });
      }
    }
  });
  return { server, db, payments };
}
async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16_384) {
      req.resume();
      fail(413, "Request too large.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail(400, "Invalid JSON.");
  }
}
function serveStatic(path: string, res: ServerResponse, directory?: string) {
  if (!directory) {
    res.writeHead(404);
    res.end("Use the Vite development server.");
    return;
  }
  const root = resolve(directory);
  const file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
  if (!file.startsWith(`${root}/`)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const target = existsSync(file) ? file : resolve(root, "index.html");
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
  };
  try {
    const data = readFileSync(target);
    res.writeHead(200, {
      "Content-Type": types[extname(target)] ?? "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Build the client first.");
  }
}
