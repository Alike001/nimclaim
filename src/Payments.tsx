import { useState, type FormEvent } from "react";
import { api, date, nim, type Claim } from "./api";
import {
  connectWallet,
  signChallenge,
  walletError,
  payoutAccounts,
  type PayoutAccounts,
} from "./wallet";
import { submitNativePayment } from "./payout-wallet";
import type {
  PaymentGate,
  PaymentReview,
  PaymentView,
} from "../shared/payments";

export function PaymentStatus({
  payment,
}: {
  payment: PaymentView | null | undefined;
}) {
  if (!payment) return null;
  const paid =
    payment.state === "CONFIRMED" && payment.receipt?.executionResult === true;
  return (
    <section className="payment-status" aria-label="Payment status">
      <h3>
        {paid
          ? payment.receipt?.source === "external"
            ? "Paid · verified on-chain"
            : "Paid · independently verified"
          : payment.state === "FAILED"
            ? "Failed · reward unpaid"
            : payment.state === "SUBMITTING"
              ? "Submission reserved · outcome unverified"
              : "Payment outcome unknown · do not retry"}
      </h3>
      <p>{payment.reason}</p>
      <dl className="payment-facts">
        <dt>{payment.receipt?.source === "external" ? "Verified sender" : "Expected sender"}</dt>
        <dd>{payment.intent.sender}</dd>
        <dt>Recipient</dt>
        <dd>{payment.intent.recipient}</dd>
        <dt>Reward</dt>
        <dd>
          {nim(payment.intent.amount)} NIM ({payment.intent.amount} Luna)
        </dd>
        <dt>Network</dt>
        <dd>{payment.intent.network}</dd>
        <dt>{payment.receipt ? "Verified fee" : "Requested fee"}</dt>
        <dd>{nim(payment.receipt?.fee ?? payment.intent.fee)} NIM</dd>
      </dl>
      {payment.receipt && (
        <div>
          <p>
            {payment.receipt.executionResult
              ? "Execution succeeded"
              : "Execution failed"}{" "}
            · inclusion block {payment.receipt.blockNumber} · finalized by macro
            block {payment.receipt.macroNumber}
          </p>
          <p>
            Verified {date(payment.receipt.verifiedAt)} against independent {payment.intent.network.toUpperCase()} RPC.
            {payment.receipt.source === "external" ? " The transfer was sent separately through Nimiq Pay; NimClaim did not broadcast or custody funds." : ""}
          </p>
          <code className="address">{payment.receipt.hash}</code>
          {payment.explorerUrl && (
            <a
              href={payment.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View {payment.intent.network} transaction in explorer
            </a>
          )}
        </div>
      )}
      <ol className="history">
        {payment.history.map((e, i) => (
          <li key={i}>
            <strong>{e.state}</strong>
            <p>{e.reason}</p>
            <time dateTime={new Date(e.at).toISOString()}>{date(e.at)}</time>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ExternalPaymentVerifier({
  claim,
  amount,
  enabled,
  reload,
}: {
  claim: Claim;
  amount: number;
  enabled: boolean;
  reload: () => Promise<void>;
}) {
  const [hash, setHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (claim.payment) return <PaymentStatus payment={claim.payment} />;

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/claims/${claim.id}/payment/verify`, {
        hash: hash.trim().toLowerCase(),
      });
      setHash("");
      await reload();
      setNotice("NIM transfer verified and recorded on MAINNET.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="manual-payment-verifier">
      <h3>Verify NIM payment</h3>
      <p>
        Send exactly {nim(amount)} NIM from this campaign's authorised organiser
        wallet to the contributor using Nimiq Pay. Then paste the transaction
        hash. NimClaim checks the sender, recipient, exact amount, execution and
        MAINNET finality. It never sends the transfer.
      </p>
      {enabled ? (
        <form onSubmit={verify}>
          <label>
            Nimiq MAINNET transaction hash
            <input
              value={hash}
              onChange={(event) => setHash(event.target.value)}
              required
              minLength={64}
              maxLength={64}
              pattern="[a-fA-F0-9]{64}"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Paste the 64-character transaction hash"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !/^[a-f0-9]{64}$/i.test(hash.trim())}
          >
            {busy ? "Verifying on MAINNET…" : "Verify NIM payment"}
          </button>
        </form>
      ) : (
        <p className="muted" role="status">
          Read-only MAINNET verification is not configured. This claim remains
          approved and unpaid until the transfer can be independently verified.
        </p>
      )}
      {error && <p role="alert" className="notice">{error}</p>}
      {notice && <p role="status" aria-live="polite">{notice}</p>}
    </div>
  );
}
export function CampaignWallet({
  campaignId,
  wallet,
  gate,
  claimsOnly,
  reload,
}: {
  campaignId: string;
  wallet: { address: string } | null;
  gate: PaymentGate;
  claimsOnly?: boolean;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function bind() {
    setBusy(true);
    setError("");
    try {
      const config = await api("/config"),
        connected = await connectWallet(config.network);
      const challenge = await api(
        `/campaigns/${campaignId}/wallet/challenge`,
        {},
      );
      const signed = await signChallenge(
        connected.provider,
        challenge.message,
        config.network,
        connected.walletAddress,
      );
      await api(`/campaigns/${campaignId}/wallet`, {
        challengeId: challenge.id,
        publicKey: signed.publicKey,
        signature: signed.signature,
      });
      await reload();
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>
        {claimsOnly ? "Organiser signing wallet" : "Organiser payout wallet"}
      </h2>
      {wallet ? (
        <>
          <p>This is the authorised campaign wallet and expected sender for verified reward payments:</p>
          <code className="address">{wallet.address}</code>
        </>
      ) : (
        <>
          <p>
            Authorize a signing wallet for this campaign. This is immutable and
            sends no funds.{" "}
            {claimsOnly
              ? "NimClaim accepts a reward payment only from this wallet. Send the exact reward to the contributor in Nimiq Pay, then verify its transaction hash here."
              : "A signing address does not establish the account Nimiq Pay will use for payments."}
          </p>
          <button disabled={busy} onClick={bind}>
            {busy ? "Waiting for wallet…" : "Authorize campaign wallet"}
          </button>
        </>
      )}
      {gate.reasons.map((reason) => (
        <p className="muted" key={reason}>
          {reason}
        </p>
      ))}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
    </section>
  );
}
export function Payout({
  claim,
  reload,
}: {
  claim: Claim;
  reload: () => Promise<void>;
}) {
  const [review, setReview] = useState<PaymentReview>(),
    [challenge, setChallenge] = useState<{ id: string; message: string }>(),
    [connected, setConnected] =
      useState<Awaited<ReturnType<typeof connectWallet>>>();
  const [accounts, setAccounts] = useState<PayoutAccounts>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [hash, setHash] = useState("");
  async function inspect() {
    setBusy(true);
    setError("");
    try {
      setReview(await api(`/claims/${claim.id}/payment/review`, {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    if (!review) return;
    setBusy(true);
    setError("");
    setChallenge(undefined);
    setAccounts(undefined);
    setConnected(undefined);
    try {
      const wallet = await connectWallet(review.network);
      const selected = await payoutAccounts(wallet.provider);
      if (selected.organiser !== review.sender)
        throw new Error(
          "Local wallet does not match the authorised organiser.",
        );
      setAccounts(selected);
      setConnected(wallet);
      setChallenge(
        await api(`/claims/${claim.id}/payment/challenge`, {
          sender: selected.htlc,
        }),
      );
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  }
  async function pay() {
    if (!review || !challenge || !connected || !accounts) return;
    setBusy(true);
    setError("");
    try {
      await payoutAccounts(connected.provider, accounts);
      const signed = await signChallenge(
        connected.provider,
        challenge.message,
        review.network,
        accounts.organiser,
      );
      await submitNativePayment(
        connected.provider,
        claim.id,
        review.network,
        accounts,
        {
          challengeId: challenge.id,
          publicKey: signed.publicKey,
          signature: signed.signature,
        },
      );
    } catch (e) {
      setError(walletError(e));
    } finally {
      setChallenge(undefined);
      await reload().catch(() => {});
      setBusy(false);
    }
  }
  async function reconcile() {
    if (!claim.payment) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/payments/${claim.payment.id}/reconcile`,
        hash.trim() ? { hash: hash.trim().toLowerCase() } : {},
      );
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PaymentStatus payment={claim.payment} />
      {claim.payment ? (
        !["CONFIRMED", "FAILED"].includes(claim.payment.state) && (
          <div>
            <label>
              Transaction hash for independent reconciliation (optional)
              <input
                value={hash}
                onChange={(e) => setHash(e.target.value)}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <p className="muted">
              A missing hash or transaction lookup does not prove that no
              payment occurred. Do not send another payment.
            </p>
            <button className="secondary" disabled={busy} onClick={reconcile}>
              Reconcile existing attempt
            </button>
          </div>
        )
      ) : (
        <button className="secondary" disabled={busy} onClick={inspect}>
          Review native NIM payment
        </button>
      )}
      {review && !claim.payment && (
        <section aria-label="Payment review" className="payment-review">
          <h3>Review native NIM payment</h3>
          <dl className="payment-facts">
            <dt>Authorising organiser</dt>
            <dd>{review.sender}</dd>
            <dt>HTLC transaction sender</dt>
            <dd>
              {review.gate.htlcVerificationSupported
                ? (accounts?.htlc ??
                  "Verified independently before reservation")
                : "Payment blocked"}
            </dd>
            <dt>Recipient</dt>
            <dd>{review.recipient}</dd>
            <dt>Reward</dt>
            <dd>
              {nim(review.amount)} NIM ({review.amount} Luna)
            </dd>
            <dt>Network</dt>
            <dd>{review.network}</dd>
            <dt>Requested fee</dt>
            <dd>
              {nim(review.fee)} NIM ({review.fee} Luna)
            </dd>
            <dt>Total requested</dt>
            <dd>{nim(review.amount + review.fee)} NIM</dd>
          </dl>
          <p>
            Requested fee is fixed in the intent. Actual execution and fees must
            be independently verified. No reward funds are held in escrow.
          </p>
          {review.gate.reasons.map((reason) => (
            <p key={reason} className="muted">
              {reason}
            </p>
          ))}
          {review.expired && <p>Campaign expired. New payments are blocked.</p>}
          <button
            disabled={busy || !review.gate.enabled || review.expired}
            onClick={prepare}
          >
            Connect wallet for payment review
          </button>
          {challenge && (
            <>
              <details>
                <summary>Review exact authorization message</summary>
                <pre>{challenge.message}</pre>
              </details>
              <p>
                The next action requests a wallet signature and native payment
                confirmation. An uncertain result must be reconciled, never
                retried.
              </p>
              <button disabled={busy || !review.gate.enabled} onClick={pay}>
                Authorize & request native payment
              </button>
            </>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
    </>
  );
}
