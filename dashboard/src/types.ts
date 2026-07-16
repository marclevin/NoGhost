/**
 * Mirror of server/src/common/types.ts (kept in sync via CONTRACTS.md).
 * Names are identical to the server-side normative types.
 */

export type RequestStatus =
  | 'PENDING'
  | 'DEBIT_CONFIRMED'
  | 'PUBLISHED' // request published on-chain (encrypted)
  | 'APPROVED' // >= quorum members posted on-chain approvals
  | 'SIGNED'
  | 'RECORDED' // multisigned receipt on-chain
  | 'DELIVERED'
  | 'REJECTED'
  | 'REJECTED_ABANDONED';

/** Which check stopped (or would stop) a request. */
export type Wall = 'WALL_1_BANK' | 'WALL_2_CONSORTIUM' | 'LEDGER' | 'POLICY';

export type SignerId = 'utility' | 'city-a' | 'city-b';

export interface GenerationRequest {
  requestId: string;
  meterId: string;
  amountKwh: number;
  merchantId: string;
  timestamp: string; // ISO-8601
}

export interface DebitConfirmation {
  debitRef: string;
  requestId: string;
  meterId: string;
  amountKwh: number;
  amount: number;
  currency: string; // 'ZAR'
  confirmedAt: string;
  bankSignature: string; // hex
}

export interface TokenPayload {
  meterId: string;
  amountKwh: number;
  nonce: string; // hex, 16 bytes
  debitRef: string;
}

export interface Token extends TokenPayload {
  signature: string; // hex, 64-byte Ed25519 (FROST aggregate)
}

export interface LedgerRecord {
  requestHash: string;
  debitRefHash: string;
  tokenHash: string;
  signerSet: SignerId[];
  timestamp: string;
  txHash: string;
  ledgerIndex?: number;
  explorerUrl: string;
  multisign?: boolean; // true when the receipt was a 2-of-3 XRPL multisign
  requestTxHash?: string; // links the receipt back to the on-chain request
}

/** A member's independent on-chain endorsement of a request (each from its own XRPL wallet). */
export interface OnChainApproval {
  signerId: SignerId;
  verdict: 'APPROVE' | 'REJECT';
  reason?: string;
  txHash: string;
  fromAddress: string;
  explorerUrl: string;
}

/** The encrypted request published on-chain (hash is the public identifier). */
export interface Publication {
  requestHash: string;
  requestTxHash: string;
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

export interface PipelineRecord {
  request: GenerationRequest;
  status: RequestStatus;
  history: StatusTransition[];
  debit?: DebitConfirmation;
  debitReversed?: boolean; // FR-21
  publication?: Publication; // on-chain encrypted request
  approvals?: OnChainApproval[]; // members' on-chain endorsements
  signerSet?: SignerId[];
  token?: Token;
  ledger?: LedgerRecord; // the 2-of-3 multisigned receipt
  rejection?: Rejection;
  meterDelivery?: { verified: boolean; dispensedKwh: number; at: string };
}

export type BankMode = 'CONFIRM' | 'DECLINE' | 'OMIT_SIGNATURE' | 'TIMEOUT';

export interface SignerHealth {
  signerId: SignerId;
  name: string;
  org: string;
  identifier: number; // FROST participant identifier (1..n)
  online: boolean;
  sharePresent: boolean;
  refuse: boolean;
  lastPartialAt: string | null;
  revoked: boolean;
  xrplAddress?: string; // this member's own on-chain account
}

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
  action: string;
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

export interface ReconciliationPoint {
  t: string; // ISO timestamp
  tokens: number;
  debits: number;
  records: number;
}

export interface Reconciliation {
  tokensIssued: number;
  confirmedDebits: number;
  onChainRecords: number;
  delta: number; // MUST be 0 in honest operation
  series: ReconciliationPoint[];
}

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

export interface ConsortiumChain {
  authority: string;
  authorityExplorerUrl: string;
  quorum: number;
  masterKeyDisabled: boolean;
  members: Partial<Record<SignerId, { address: string; explorerUrl: string }>>;
}

export interface ConsortiumStatus {
  threshold: { t: number; n: number };
  groupPublicKey: string;
  signers: SignerHealth[];
  quorumReachable: boolean;
  chain?: ConsortiumChain; // on-chain consortium (authority + member accounts)
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
  | {
      type: 'governance.updated';
      members: ConsortiumMember[];
      merchants: Merchant[];
      governanceLog: GovernanceLogEntry[];
    }
  | { type: 'meter.updated'; meter: MeterState };
