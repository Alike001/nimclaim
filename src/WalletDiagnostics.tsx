import { useState } from "react";
import { init, getHostNetwork, NimiqProviderError } from "@nimiq/mini-app-sdk";
import { api } from "./api";
export function diagnosticError(error: unknown) {
  if (NimiqProviderError.is(error)) {
    if (error.type === "PERMISSION_DENIED") return "Wallet request cancelled.";
    if (error.type === "NETWORK_ERROR")
      return "Wallet network request unavailable.";
    if (error.type === "UNKNOWN_REQUEST")
      return "Wallet version does not support this request.";
    return "Wallet request failed. No private error details are shown.";
  }
  return "Provider or status request unavailable. No private error details are shown.";
}
function safeHostNetwork() {
  const value = getHostNetwork();
  return value === "testnet" || value === "mainnet" ? value : "unavailable";
}
export function WalletDiagnostics({
  expectedNetwork,
}: {
  expectedNetwork: string;
}) {
  const [result, setResult] = useState<{
    apiNetwork: string;
    hostNetwork: string;
    provider: boolean;
    consensus: string;
    height: string;
    checked: string;
    error: string;
  }>();
  const [busy, setBusy] = useState(false);
  async function check() {
    setBusy(true);
    const next = {
      apiNetwork: "unavailable",
      hostNetwork: safeHostNetwork(),
      provider: !!window.nimiq,
      consensus: "unavailable",
      height: "unavailable",
      checked: new Date().toLocaleTimeString(),
      error: "",
    };
    try {
      const config = await api("/config");
      next.apiNetwork = ["testnet", "mainnet"].includes(config.network)
        ? config.network
        : "unavailable";
      const provider = await init({ timeout: 3000 });
      next.provider = true;
      next.hostNetwork = safeHostNetwork();
      const [consensus, height] = await Promise.allSettled([
        provider.isConsensusEstablished(),
        provider.getBlockNumber(),
      ]);
      if (
        consensus.status === "fulfilled" &&
        typeof consensus.value === "boolean"
      )
        next.consensus = consensus.value ? "established" : "syncing";
      if (
        height.status === "fulfilled" &&
        Number.isSafeInteger(height.value) &&
        height.value >= 0
      )
        next.height = String(height.value);
      if (consensus.status === "rejected" || height.status === "rejected")
        next.error = "One or more wallet status queries are unavailable.";
    } catch (e) {
      next.error = diagnosticError(e);
    }
    setResult(next);
    setBusy(false);
  }
  const host = result?.hostNetwork ?? safeHostNetwork();
  const matches =
    !!result &&
    result.apiNetwork === expectedNetwork &&
    host === expectedNetwork;
  return (
    <section className="panel" aria-label="Read-only wallet diagnostics">
      <h2>Wallet diagnostics</h2>
      <p>
        Read-only checks. This panel never requests accounts, signatures or
        payments, and shows no wallet addresses.
      </p>
      <dl className="payment-facts">
        <dt>SDK</dt>
        <dd>Loaded</dd>
        <dt>Injected provider</dt>
        <dd>
          {(result?.provider ?? !!window.nimiq) ? "detected" : "not detected"}
        </dd>
        <dt>HTTPS page</dt>
        <dd>
          {location.protocol === "https:"
            ? "yes"
            : "no — use private HTTPS on the phone"}
        </dd>
        <dt>Frontend expected network</dt>
        <dd>{expectedNetwork.toUpperCase()}</dd>
        <dt>API network readback</dt>
        <dd>{result?.apiNetwork.toUpperCase() ?? "not checked"}</dd>
        <dt>Host provider network</dt>
        <dd>{host.toUpperCase()}</dd>
        <dt>Network agreement</dt>
        <dd>
          {matches
            ? "MATCH — API and host metadata agree"
            : "NOT VERIFIED — do not sign a claim"}
        </dd>
        <dt>Consensus</dt>
        <dd>{result?.consensus ?? "not checked"}</dd>
        <dt>Provider block height</dt>
        <dd>{result?.height ?? "not checked"}</dd>
      </dl>
      <button disabled={busy} className="secondary" onClick={check}>
        {busy ? "Checking provider…" : "Refresh wallet diagnostics"}
      </button>
      {result && (
        <p role="status">
          Checked {result.checked}. {result.error}
        </p>
      )}
      <p className="muted">
        The badge alone is not proof. Compare the API readback and injected host
        network with Nimiq Pay’s Testnet setting. Reload this page after
        changing networks. Message signing proves key control, not independent
        blockchain network identity.
      </p>
    </section>
  );
}
