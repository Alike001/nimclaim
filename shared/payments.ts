export type Network = "testnet" | "mainnet";
export interface Intent {
  id: string;
  claim_id: string;
  campaign_id: string;
  sender: string;
  recipient: string;
  amount: number;
  fee: number;
  network: Network;
  /** Reservation head: minimum acceptable inclusion block, not the native validity start. */
  validity_start_height: number;
  created: number;
  expires: number;
}
export interface Receipt {
  hash: string;
  blockNumber: number;
  blockHash: string;
  macroNumber: number;
  macroHash: string;
  executionResult: boolean;
  verifiedAt: number;
  sender: string;
  recipient: string;
  amount: number;
  fee: number;
  network: Network;
}
export interface PaymentGate {
  enabled: boolean;
  /** Atomic wallet commitment to the reserved sender through native confirmation.
   * The current Mini App SDK provides no such guarantee; always false. */
  senderBindingSupported: boolean;
  /** Server can validate HTLC funding and reconcile its exact sender independently.
   * Does not guarantee fresh host accounts or bind the wallet's next transaction. */
  htlcVerificationSupported: boolean;
  reasons: string[];
}
export type PaymentState = "SUBMITTING" | "UNKNOWN" | "CONFIRMED" | "FAILED";
export interface PaymentView {
  intent: Intent;
  id: string;
  state: PaymentState;
  reason: string;
  candidateHash: string | null;
  receipt: Receipt | null;
  explorerUrl: string | null;
  history: { state: PaymentState; reason: string; at: number }[];
}
export interface PaymentReview {
  campaignId: string;
  claimId: string;
  sender: string;
  recipient: string;
  amount: number;
  fee: number;
  network: Network;
  expires: number;
  gate: PaymentGate;
  expired: boolean;
  payment: PaymentView | null;
}
