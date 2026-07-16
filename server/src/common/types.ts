/**
 * Shared domain types — the single source of truth for every service.
 * The dashboard mirrors these in dashboard/src/types.ts (kept in sync via CONTRACTS.md).
 */

export type RequestStatus =
  | 'PENDING'
  | 'DEBIT_CONFIRMED'
  | 'SIGNED'
  | 'RECORDED'
  | 'DELIVERED'
  | 'REJECTED'
  | 'REJECTED_ABANDONED';

/** Which check stopped (or would stop) a request. */
export type Wall = 'WALL_1_BANK' | 'WALL_2_CONSORTIUM' | 'LEDGER' | 'POLICY';

export type SignerId = 'utility' | 'city-a' | 'city-b';

/** §4.1 Generation request */
export interface GenerationRequest {
  requestId: string;
  meterId: string;
  amountKwh: number;
  merchantId: string;
  timestamp: string; // ISO-8601
}

/** §4.2 Confirmed-debit reference (Wall 1). bankSignature is Ed25519 over canonicalBytes of the payload minus bankSignature. */
export interface DebitConfirmation {
  debitRef: string;
  requestId: string;
  amount: number;
  currency: string; // 'ZAR'
  confirmedAt: string;
  bankSignature: string; // hex
}

/** The exact payload the bank signs (canonical form of DebitConfirmation without bankSignature). */
export type DebitSignedPayload = Omit<DebitConfirmation, 'bankSignature'>;

/** §4.3 Token payload — the message signed by the FROST quorum is canonicalBytes(TokenPayload). */
export interface TokenPayload {
  meterId: string;
  amountKwh: number;
  nonce: string; // hex, 16 bytes
}

export interface Token extends TokenPayload {
  signature: string; // hex, 64-byte Ed25519 (FROST aggregate), verifies against group public key
}

/** §4.4 On-chain authorisation record (hashes only, POPIA-safe). */
export interface LedgerRecord {
  requestHash: string;
  debitRefHash: string;
  tokenHash: string;
  signerSet: SignerId[];
  timestamp: string;
  txHash: string;
  ledgerIndex?: number;
  explorerUrl: string;
}

export interface Rejection {
  wall: Wall;
  reason: string;
  at: string;
  /** attribution — who/what caused the rejection (NFR-2) */
  attribution: string;
}

export interface StatusTransition {
  status: RequestStatus;
  at: string;
  note?: string;
}

/** Full lifecycle of a request as tracked by the coordinator. */
export interface PipelineRecord {
  request: GenerationRequest;
  status: RequestStatus;
  history: StatusTransition[];
  debit?: DebitConfirmation;
  debitReversed?: boolean; // FR-21
  signerSet?: SignerId[];
  token?: Token;
  ledger?: LedgerRecord;
  rejection?: Rejection;
  meterDelivery?: { verified: boolean; dispensedKwh: number; at: string };
}

// ---------------------------------------------------------------------------
// Bank service
// ---------------------------------------------------------------------------

export type BankMode = 'CONFIRM' | 'DECLINE' | 'OMIT_SIGNATURE' | 'TIMEOUT';

export interface DebitRequest {
  requestId: string;
  merchantId: string;
  amount: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// Signer service
// ---------------------------------------------------------------------------

export interface SignerHealth {
  signerId: SignerId;
  name: string;
  org: string;
  identifier: number; // FROST participant identifier (1..n)
  online: boolean;
  sharePresent: boolean;
  refuse: boolean;
  lastPartialAt: string | null;
  revoked: boolean; // set by coordinator governance, not the signer itself
}

export interface Round1Response {
  signerId: SignerId;
  identifier: number;
  commitment: { hiding: string; binding: string }; // hex points
}

export interface Round2Request {
  sessionId: string; // == requestId
  messageHex: string; // hex(canonicalBytes(TokenPayload)) — signers re-derive and compare
  tokenPayload: TokenPayload;
  request: GenerationRequest;
  debit: DebitConfirmation;
  commitments: Array<{ identifier: number; hiding: string; binding: string }>;
}

export interface Round2Response {
  signerId: SignerId;
  identifier: number;
  zi: string; // hex scalar — partial signature share
}

// ---------------------------------------------------------------------------
// Governance / consortium
// ---------------------------------------------------------------------------

export interface ConsortiumMember {
  signerId: SignerId;
  name: string;
  org: string;
  identifier: number;
  status: 'ACTIVE' | 'REVOKED';
  /** conceptual bond posture (FRD §6.2-D) — displayed, not enforced */
  bond: { posture: 'BONDED'; amountZar: number; note: string };
}

export interface GovernanceLogEntry {
  id: string;
  at: string;
  action: string; // e.g. 'MEMBER_REVOKED', 'MEMBER_REINSTATED', 'MERCHANT_REVOKED'
  subject: string;
  actor: string;
  detail?: string;
}

export interface Merchant {
  merchantId: string;
  name: string;
  vetted: boolean;
  revoked: boolean;
}

// ---------------------------------------------------------------------------
// Reconciliation (§6.2-C)
// ---------------------------------------------------------------------------

export interface ReconciliationPoint {
  t: string; // ISO timestamp
  tokens: number;
  debits: number;
  records: number;
}

export interface Reconciliation {
  tokensIssued: number;
  confirmedDebits: number; // net of FR-21 reversals
  onChainRecords: number;
  delta: number; // MUST be 0 in honest operation
  series: ReconciliationPoint[];
}

// ---------------------------------------------------------------------------
// Alerts + live events
// ---------------------------------------------------------------------------

export interface Alert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  wall?: Wall;
  requestId?: string;
  title: string;
  message: string;
  attribution: string;
  at: string;
}

export interface BankStatus {
  up: boolean;
  mode: BankMode;
  confirmRatePct: number; // over last 20 debit attempts
  lastConfirmationAt: string | null;
}

export interface ConsortiumStatus {
  threshold: { t: number; n: number };
  groupPublicKey: string;
  signers: SignerHealth[];
  quorumReachable: boolean;
}

export interface MeterState {
  meterId: string;
  balanceKwh: number;
  lastDispenseAt: string | null;
  dispenses: number;
}

export interface Snapshot {
  requests: PipelineRecord[]; // newest first
  bank: BankStatus;
  consortium: ConsortiumStatus;
  reconciliation: Reconciliation;
  alerts: Alert[]; // newest first
  members: ConsortiumMember[];
  merchants: Merchant[];
  governanceLog: GovernanceLogEntry[];
  meters: MeterState[];
  demo: { activeScenario: string | null };
}

/** WebSocket wire protocol — every message is one of these JSON objects. */
export type WsEvent =
  | { type: 'hello'; state: Snapshot }
  | { type: 'request.updated'; record: PipelineRecord }
  | { type: 'bank.status'; bank: BankStatus }
  | { type: 'consortium.status'; consortium: ConsortiumStatus }
  | { type: 'reconciliation'; reconciliation: Reconciliation }
  | { type: 'alert'; alert: Alert }
  | { type: 'governance.updated'; members: ConsortiumMember[]; merchants: Merchant[]; governanceLog: GovernanceLogEntry[] }
  | { type: 'meter.updated'; meter: MeterState };
