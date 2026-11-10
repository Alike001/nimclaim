import type { PaymentGate, PaymentView } from "../shared/payments.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomic, type DB } from "./db.js";
import { digest, randomToken, verifyOwner } from "./crypto.js";
import {
  chain,
  address,
  verifyHtlc,
  hashSchema,
  verifiedHead,
  verifyPayment,
  EvidenceMismatch,
  type Intent,
  type Network,
  type Rpc,
} from "./rpc.js";

export class PaymentError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function requirePayment(
  ok: unknown,
  status: number,
  message: string,
): asserts ok {
  if (!ok) throw new PaymentError(status, message);
}
export const proofSchema = z
  .object({
    challengeId: z.string().uuid(),
    publicKey: z.string().regex(/^[a-f0-9]{64}$/i),
    signature: z.string().regex(/^[a-f0-9]{128}$/i),
  })
  .strict();
type Proof = z.infer<typeof proofSchema>;
type Row = Record<string, any>;
export interface PaymentOptions {
  origin: string;
  network: Network;
  now: () => number;
  enabled?: boolean;
  spendingNetwork?: Network;
  maxLuna?: number;
  feeLuna?: number;
  rpc?: Rpc;
}
export class Payments {
  constructor(
    private db: DB,
    private options: PaymentOptions,
  ) {}
  private get(sql: string, ...args: any[]) {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  private log(id: string, state: string, reason: string) {
    this.run(
      "INSERT INTO payment_events (attempt_id,state,reason,at) VALUES (?,?,?,?)",
      id,
      state,
      reason,
      this.options.now(),
    );
  }
  gate(): PaymentGate {
    const reasons: string[] = [];
    if (!this.options.origin.startsWith("https://"))
      reasons.push("Native spending requires an HTTPS app origin.");
    if (!this.options.enabled)
      reasons.push("Spending is disabled by server configuration.");
    if (this.options.spendingNetwork !== this.options.network)
      reasons.push(
        "The spending network has not been explicitly authorized on the server.",
      );
    if (
      !Number.isSafeInteger(this.options.maxLuna) ||
      this.options.maxLuna! <= 0
    )
      reasons.push("A positive server-side per-payment limit is required.");
    if (!this.options.rpc)
      reasons.push("Independent Nimiq RPC is not configured.");
    if (this.options.network === "mainnet")
      reasons.push("Mainnet spending is disabled for the HTLC integration.");
    return {
      enabled: reasons.length === 0,
      senderBindingSupported: false,
      htlcVerificationSupported: true,
      reasons,
    };
  }
  wallet(campaignId: string) {
    return (
      this.get(
        "SELECT address,created FROM campaign_wallets WHERE campaign_id=?",
        campaignId,
      ) ?? null
    );
  }
  private campaign(id: string) {
    const c = this.get("SELECT * FROM campaigns WHERE id=?", id);
    requirePayment(c, 404, "Campaign not found.");
    return c;
  }
  private details(claimId: string) {
    const c = this.get("SELECT * FROM claims WHERE id=?", claimId);
    requirePayment(c, 404, "Claim not found.");
    requirePayment(
      c.status === "payment-ready",
      409,
      "Only an approved immutable claim can be paid.",
    );
    const campaign = this.campaign(c.campaign_id),
      wallet = this.wallet(c.campaign_id);
    requirePayment(
      wallet,
      409,
      "Authorize the campaign organiser wallet first.",
    );
    const count = this.get(
      "SELECT COUNT(*) AS n FROM claims WHERE campaign_id=?",
      c.campaign_id,
    )!.n;
    requirePayment(
      count <= campaign.slots,
      409,
      "Campaign allocation exceeded.",
    );
    return {
      campaignId: c.campaign_id as string,
      claimId,
      sender: wallet.address as string,
      recipient: c.address as string,
      amount: campaign.amount as number,
      fee: this.options.feeLuna ?? 0,
      network: this.options.network,
      expires: campaign.expires as number,
    };
  }
  review(claimId: string) {
    const details = this.details(claimId);
    requirePayment(
      Number.isSafeInteger(details.amount + details.fee) && details.fee >= 0,
      409,
      "Payment fee or total is outside the safe integer range.",
    );
    return {
      ...details,
      gate: this.gate(),
      expired: details.expires <= this.options.now(),
      payment: this.view(claimId),
    };
  }
  challenge(
    campaignId: string,
    sessionHash: string,
    claimId?: string,
    funding?: {
      sender: string;
      organiser: string;
      htlcRecipient: string;
      htlcTimeout: number;
    },
  ) {
    const campaign = this.campaign(campaignId);
    requirePayment(
      campaign.expires > this.options.now(),
      410,
      "Campaign has expired.",
    );
    const details = claimId
      ? { ...this.details(claimId), ...funding }
      : {
          campaignId,
          amount: campaign.amount,
          slots: campaign.slots,
          expires: campaign.expires,
          network: this.options.network,
        };
    requirePayment(
      details.campaignId === campaignId,
      409,
      "Campaign mismatch.",
    );
    if (!claimId)
      requirePayment(
        !this.wallet(campaignId),
        409,
        "Campaign wallet is already authorized and immutable.",
      );
    if (claimId)
      requirePayment(funding, 409, "Verified HTLC funding is required.");
    const id = randomUUID(),
      expires = Math.min(this.options.now() + 300_000, campaign.expires),
      purpose = claimId ? "pay" : "bind";
    const message = JSON.stringify({
      domain: `NimClaim/organiser/${purpose}/${claimId ? "v2" : "v1"}`,
      purpose: claimId
        ? "Authorize this exact reward payment intent; this signature alone sends no funds"
        : "Authorize this signing wallet for this campaign; this does not prove the payment sender",
      origin: this.options.origin,
      network: this.options.network,
      details,
      nonce: randomToken(),
      expires,
    });
    atomic(this.db, () => {
      this.run(
        "DELETE FROM organiser_challenges WHERE expires<=? AND used=0",
        this.options.now(),
      );
      this.run(
        "DELETE FROM organiser_challenges WHERE campaign_id=? AND session_hash=? AND purpose=? AND used=0",
        campaignId,
        sessionHash,
        purpose,
      );
      this.run(
        "INSERT INTO organiser_challenges VALUES (?,?,?,?,?,?,0)",
        id,
        campaignId,
        sessionHash,
        purpose,
        message,
        expires,
      );
    });
    return { id, message, expires };
  }
  private async funding(claimId: string, sender: string) {
    const details = this.details(claimId);
    requirePayment(this.options.rpc, 503, "Independent RPC is not configured.");
    try {
      return await verifyHtlc(
        this.options.rpc,
        details.network,
        address(sender),
        details.sender,
        details.amount,
        details.fee,
        this.options.now(),
      );
    } catch (error) {
      throw new PaymentError(
        409,
        error instanceof Error ? error.message : "HTLC verification failed.",
      );
    }
  }
  async paymentChallenge(claimId: string, sessionHash: string, sender: string) {
    const details = this.details(claimId);
    const funding = await this.funding(claimId, sender);
    return this.challenge(details.campaignId, sessionHash, claimId, funding);
  }
  private proof(
    campaignId: string,
    sessionHash: string,
    purpose: string,
    input: Proof,
  ) {
    const row = this.get(
      "SELECT * FROM organiser_challenges WHERE id=? AND campaign_id=? AND session_hash=? AND purpose=?",
      input.challengeId,
      campaignId,
      sessionHash,
      purpose,
    );
    requirePayment(
      row && !row.used && row.expires > this.options.now(),
      409,
      "Organiser signing request expired or already used.",
    );
    const binding = JSON.parse(row.message);
    requirePayment(
      binding.origin === this.options.origin &&
        binding.network === this.options.network,
      409,
      "Organiser signing domain changed.",
    );
    const signer = verifyOwner(row.message, input.publicKey, input.signature);
    requirePayment(signer, 401, "Invalid organiser wallet signature.");
    return { row, binding, signer };
  }
  bind(campaignId: string, sessionHash: string, input: Proof) {
    return atomic(this.db, () => {
      const { row, signer } = this.proof(
        campaignId,
        sessionHash,
        "bind",
        input,
      );
      requirePayment(
        this.campaign(campaignId).expires > this.options.now(),
        410,
        "Campaign expired.",
      );
      requirePayment(
        !this.wallet(campaignId),
        409,
        "Campaign wallet is immutable.",
      );
      this.run(
        "INSERT INTO campaign_wallets VALUES (?,?,?,?,?,?)",
        campaignId,
        signer,
        input.publicKey,
        input.signature,
        row.id,
        this.options.now(),
      );
      this.run("UPDATE organiser_challenges SET used=1 WHERE id=?", row.id);
      return this.wallet(campaignId);
    });
  }
  async reserve(claimId: string, sessionHash: string, input: Proof) {
    const details = this.details(claimId);
    requirePayment(
      details.expires > this.options.now(),
      410,
      "Campaign has expired; no new payment can begin.",
    );
    requirePayment(
      Number.isSafeInteger(details.amount + details.fee) && details.fee >= 0,
      409,
      "Payment fee or total is invalid.",
    );
    const gate = this.gate();
    requirePayment(gate.enabled, 409, gate.reasons.join(" "));
    const { row, signer, binding } = this.proof(
      details.campaignId,
      sessionHash,
      "pay",
      input,
    );
    requirePayment(
      signer === details.sender,
      403,
      "Signing wallet does not match the campaign organiser wallet.",
    );
    requirePayment(
      JSON.stringify(binding.details) ===
        JSON.stringify({
          ...details,
          ...(await this.funding(claimId, binding.details.sender)),
        }),
      409,
      "Payment details changed. Review again.",
    );
    requirePayment(
      details.amount <= this.options.maxLuna!,
      403,
      "Payment exceeds the server spending limit.",
    );
    const height = await verifiedHead(this.options.rpc!, details.network);
    const permit = randomToken();
    const result = atomic(this.db, () => {
      const current = this.details(claimId);
      requirePayment(
        JSON.stringify(current) === JSON.stringify(details),
        409,
        "Immutable payment details changed.",
      );
      requirePayment(
        current.expires > this.options.now(),
        410,
        "Campaign has expired; no new payment can begin.",
      );
      requirePayment(
        binding.details.htlcTimeout > this.options.now(),
        409,
        "HTLC expired during reservation. Payment blocked.",
      );
      this.proof(details.campaignId, sessionHash, "pay", input);
      requirePayment(
        !this.get("SELECT id FROM payment_intents WHERE claim_id=?", claimId),
        409,
        "A durable payment attempt already exists. Reconcile it; never resubmit.",
      );
      const allocated = this.get(
        "SELECT COUNT(*) AS n FROM payment_intents WHERE campaign_id=?",
        details.campaignId,
      )!.n;
      requirePayment(
        allocated < this.campaign(details.campaignId).slots,
        409,
        "Campaign allocation is exhausted.",
      );
      const intent: Intent = {
        id: randomUUID(),
        claim_id: claimId,
        campaign_id: details.campaignId,
        sender: binding.details.sender,
        recipient: details.recipient,
        amount: details.amount,
        fee: details.fee,
        network: details.network,
        validity_start_height: height,
        created: this.options.now(),
        expires: Math.min(details.expires, this.options.now() + 90_000),
      };
      this.run(
        "INSERT INTO payment_intents VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        intent.id,
        intent.claim_id,
        intent.campaign_id,
        intent.sender,
        intent.recipient,
        intent.amount,
        intent.fee,
        intent.network,
        intent.validity_start_height,
        intent.created,
        intent.expires,
      );
      const id = randomUUID(),
        reason =
          "Intent and attempt durably reserved before any wallet broadcast request.";
      this.run(
        "INSERT INTO payment_attempts (id,intent_id,state,created,updated,reason,permit_hash) VALUES (?,?,'SUBMITTING',?,?,?,?)",
        id,
        intent.id,
        this.options.now(),
        this.options.now(),
        reason,
        digest(permit),
      );
      this.log(id, "SUBMITTING", reason);
      this.run(
        "UPDATE organiser_challenges SET used=1 WHERE id=? AND used=0",
        row.id,
      );
      return { id, intent };
    });
    return { ...result, permit };
  }
  dispatch(id: string, permit: string) {
    return atomic(this.db, () => {
      const gate = this.gate();
      requirePayment(gate.enabled, 409, gate.reasons.join(" "));
      const { attempt, intent } = this.attempt(id);
      requirePayment(
        attempt.state === "SUBMITTING" &&
          !attempt.dispatched &&
          attempt.permit_hash === digest(permit) &&
          intent.expires > this.options.now(),
        409,
        "Broadcast permission expired or already consumed. Reconcile; do not retry.",
      );
      this.run(
        "UPDATE payment_attempts SET dispatched=1,updated=? WHERE id=? AND dispatched=0",
        this.options.now(),
        id,
      );
      this.log(
        id,
        "SUBMITTING",
        "One-time dispatch permit consumed. A missing response must not be retried.",
      );
      return { broadcastAllowed: true, intent, attemptId: id };
    });
  }
  private attempt(id: string) {
    const attempt = this.get("SELECT * FROM payment_attempts WHERE id=?", id);
    requirePayment(attempt, 404, "Payment attempt not found.");
    const intent = this.get(
      "SELECT * FROM payment_intents WHERE id=?",
      attempt.intent_id,
    ) as Intent;
    return { attempt, intent };
  }
  outcome(
    id: string,
    outcome: "hash" | "cancelled" | "error" | "timeout",
    hash?: string,
  ) {
    if (hash) hashSchema.parse(hash);
    atomic(this.db, () => {
      const { attempt } = this.attempt(id);
      if (["CONFIRMED", "FAILED"].includes(attempt.state)) {
        requirePayment(
          !hash || attempt.candidate_hash === hash,
          409,
          "A different hash cannot replace a finalized payment receipt.",
        );
        return;
      }
      requirePayment(
        !hash || !attempt.candidate_hash || attempt.candidate_hash === hash,
        409,
        "Different transaction hint already recorded. Use independent reconciliation.",
      );
      // Browser-reported cancellation is not authoritative evidence that broadcasting was impossible.
      const reason =
        outcome === "cancelled"
          ? "Wallet cancellation reported; independently reconcile before any further action."
          : outcome === "hash"
            ? "Transaction hash received; execution and finality are not verified."
            : "Wallet response missing or ambiguous. Never auto-retry.";
      try {
        this.run(
          "UPDATE payment_attempts SET state='UNKNOWN', candidate_hash=COALESCE(candidate_hash,?),updated=?,reason=? WHERE id=?",
          hash ?? null,
          this.options.now(),
          reason,
          id,
        );
      } catch {
        throw new PaymentError(
          409,
          "This hash is already assigned to a different payment attempt.",
        );
      }
      this.log(id, "UNKNOWN", reason);
    });
    return this.view(this.attempt(id).intent.claim_id);
  }
  async reconcile(id: string, hash?: string) {
    const { attempt, intent } = this.attempt(id);
    if (["CONFIRMED", "FAILED"].includes(attempt.state)) {
      requirePayment(
        !hash || attempt.candidate_hash === hash,
        409,
        "A different hash cannot replace a finalized payment receipt.",
      );
      return this.view(intent.claim_id);
    }
    const candidate = hash ?? attempt.candidate_hash;
    if (!candidate) return this.outcome(id, "timeout");
    hashSchema.parse(candidate);
    requirePayment(
      this.options.rpc,
      503,
      "Independent RPC is not configured. No payment outcome can be verified.",
    );
    let evidence;
    try {
      evidence = await verifyPayment(
        this.options.rpc,
        intent,
        candidate,
        this.options.now(),
        this.wallet(intent.campaign_id)!.address,
      );
    } catch (error) {
      if (!(error instanceof EvidenceMismatch)) throw error;
      this.outcome(id, "error");
      throw new PaymentError(
        409,
        "Rejected transaction: sender, recipient, amount, fee, network or validity does not match this payment.",
      );
    }
    atomic(this.db, () => {
      const current = this.attempt(id).attempt;
      if (["CONFIRMED", "FAILED"].includes(current.state)) return;
      if (evidence.receipt) {
        const used = this.get(
          "SELECT attempt_id FROM payment_hashes WHERE hash=?",
          candidate,
        );
        requirePayment(
          !used || used.attempt_id === id,
          409,
          "Verified transaction hash already consumed by another claim.",
        );
        this.run(
          "INSERT OR IGNORE INTO payment_hashes VALUES (?,?)",
          candidate,
          id,
        );
      }
      try {
        this.run(
          "UPDATE payment_attempts SET state=?,candidate_hash=?,reason=?,receipt=?,updated=? WHERE id=?",
          evidence.state,
          candidate,
          evidence.reason,
          evidence.receipt ? JSON.stringify(evidence.receipt) : null,
          this.options.now(),
          id,
        );
      } catch {
        throw new PaymentError(
          409,
          "Transaction hash already assigned to another attempt.",
        );
      }
      this.log(id, evidence.state, evidence.reason);
    });
    return this.view(intent.claim_id);
  }
  view(claimId: string): PaymentView | null {
    const intent = this.get(
      "SELECT * FROM payment_intents WHERE claim_id=?",
      claimId,
    ) as Intent | undefined;
    if (!intent) return null;
    const attempt = this.get(
      "SELECT * FROM payment_attempts WHERE intent_id=?",
      intent.id,
    )!;
    if (
      attempt.state === "SUBMITTING" &&
      intent.expires <= this.options.now()
    ) {
      atomic(this.db, () => {
        const reason =
          "Dispatch window expired with no independently verified outcome. Do not retry.";
        const result = this.run(
          "UPDATE payment_attempts SET state='UNKNOWN',reason=?,updated=? WHERE id=? AND state='SUBMITTING'",
          reason,
          this.options.now(),
          attempt.id,
        );
        if (Number(result.changes)) this.log(attempt.id, "UNKNOWN", reason);
      });
      return this.view(claimId);
    }
    const receipt = attempt.receipt ? JSON.parse(attempt.receipt) : null;
    return {
      intent,
      id: attempt.id,
      state: attempt.state,
      reason: attempt.reason,
      candidateHash: attempt.candidate_hash,
      receipt,
      explorerUrl: receipt
        ? `${chain[intent.network].explorer}/#${receipt.hash}`
        : null,
      history: this.db
        .prepare(
          "SELECT state,reason,at FROM payment_events WHERE attempt_id=? ORDER BY id",
        )
        .all(attempt.id) as unknown as PaymentView["history"],
    };
  }
}
