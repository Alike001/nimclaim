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
  senderBindingSupported: boolean;
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
