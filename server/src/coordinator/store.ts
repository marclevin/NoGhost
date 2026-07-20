/**
 * Coordinator in-memory state: requests, alerts, merchants, consortium members,
 * governance log, meters, consumed debitRefs — plus the Snapshot builder,
 * reconciliation computation and the WsEvent bus every mutation broadcasts on.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KEYS_DIR, SIGNERS, THRESHOLD, XRPL_EXPLORER_ACCOUNT, type SignerInfo } from '../common/config.js';
import { loadManifest } from '../common/chain.js';
import type {
  Alert,
  BankMode,
  BankStatus,
  ConsortiumChain,
  ConsortiumMember,
  ConsortiumStatus,
  GenerationRequest,
  GovernanceLogEntry,
  LedgerRecord,
  Merchant,
  MeterState,
  PipelineRecord,
  Reconciliation,
  ReconciliationPoint,
  RequestStatus,
  SignerHealth,
  SignerId,
  Snapshot,
  WsEvent,
} from '../common/types.js';

// ---------------------------------------------------------------------------
// public key material (loaded once at boot — no secrets live here)
// ---------------------------------------------------------------------------

export const GROUP: {
  groupPublicKey: string;
  threshold: number;
  total: number;
  verificationShares: Record<string, string>;
} = JSON.parse(readFileSync(resolve(KEYS_DIR, 'group.json'), 'utf8'));

/** FR-3 trust anchor: the bank public key is pinned from disk, never fetched. */
export const BANK_PUBLIC_KEY: string = (
  JSON.parse(readFileSync(resolve(KEYS_DIR, 'bank.pub.json'), 'utf8')) as { publicKey: string }
).publicKey;

/** On-chain consortium (authority + member accounts) — undefined until setup:xrpl has run. */
export const CONSORTIUM_CHAIN: ConsortiumChain | null = (() => {
  try {
    const m = loadManifest();
    return {
      authority: m.authority,
      authorityExplorerUrl: XRPL_EXPLORER_ACCOUNT(m.authority),
      quorum: m.quorum,
      masterKeyDisabled: m.masterKeyDisabled,
      members: Object.fromEntries(
        Object.entries(m.members).map(([id, addr]) => [id, { address: addr, explorerUrl: XRPL_EXPLORER_ACCOUNT(addr) }]),
      ),
    };
  } catch {
    return null;
  }
})();

// ---------------------------------------------------------------------------
// constants / helpers
// ---------------------------------------------------------------------------

const REQUEST_CAP = 200;
const ALERT_CAP = 100;
const SERIES_CAP = 200;
const GOVLOG_CAP = 200;
const DEBIT_OUTCOME_WINDOW = 20;

export const TERMINAL: ReadonlySet<RequestStatus> = new Set(['DELIVERED', 'REJECTED', 'REJECTED_ABANDONED']);

const now = () => new Date().toISOString();

export function log(evt: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: now(), svc: 'coordinator', evt, ...data }));
}

// ---------------------------------------------------------------------------
// event bus (WS hub + demo scenario restore subscribe here)
// ---------------------------------------------------------------------------

type Listener = (ev: WsEvent) => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function broadcast(ev: WsEvent): void {
  for (const l of [...listeners]) {
    try {
      l(ev);
    } catch (err) {
      log('listener.error', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------

const requests = new Map<string, PipelineRecord>();
const requestOrder: string[] = []; // newest first

export function getRequest(requestId: string): PipelineRecord | undefined {
  return requests.get(requestId);
}

export function listRequests(): PipelineRecord[] {
  return requestOrder.map((id) => requests.get(id)!).filter(Boolean);
}

export function createRecord(request: GenerationRequest): PipelineRecord {
  const record: PipelineRecord = {
    request,
    status: 'PENDING',
    history: [{ status: 'PENDING', at: request.timestamp, note: `merchant ${request.merchantId}` }],
  };
  requests.set(request.requestId, record);
  requestOrder.unshift(request.requestId);
  while (requestOrder.length > REQUEST_CAP) {
    const evicted = requestOrder.pop()!;
    requests.delete(evicted);
  }
  log('request.created', { requestId: request.requestId, meterId: request.meterId, amountKwh: request.amountKwh });
  broadcast({ type: 'request.updated', record });
  return record;
}

/** Every state change goes through here: appends history + broadcasts (NFR-5). */
export function transition(record: PipelineRecord, status: RequestStatus, note?: string): void {
  record.status = status;
  record.history.push({ status, at: now(), ...(note ? { note } : {}) });
  log('request.transition', { requestId: record.request.requestId, status, note });
  broadcast({ type: 'request.updated', record });
  if (TERMINAL.has(status)) onTerminal(status);
}

// ---------------------------------------------------------------------------
// FR-20 — one debit, one token: consumed debitRef registry
// ---------------------------------------------------------------------------

const consumedDebitRefs = new Map<string, string>(); // debitRef -> requestId that consumed it

/** Atomically claim a debitRef for a request (JS single-threaded — no await between check & set). */
export function claimDebitRef(debitRef: string, requestId: string): { ok: true } | { ok: false; byRequestId: string } {
  const owner = consumedDebitRefs.get(debitRef);
  if (owner && owner !== requestId) return { ok: false, byRequestId: owner };
  consumedDebitRefs.set(debitRef, requestId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------

const alerts: Alert[] = []; // newest first

export function addAlert(a: Omit<Alert, 'id' | 'at'>): Alert {
  const alert: Alert = { id: randomUUID(), at: now(), ...a };
  alerts.unshift(alert);
  if (alerts.length > ALERT_CAP) alerts.pop();
  log('alert', { severity: alert.severity, title: alert.title, attribution: alert.attribution, requestId: alert.requestId });
  broadcast({ type: 'alert', alert });
  return alert;
}

// ---------------------------------------------------------------------------
// merchants + consortium members + governance log (seeded at boot, NFR-4)
// ---------------------------------------------------------------------------

const merchants: Merchant[] = [
  { merchantId: 'MER-001', name: "Thabo's Spaza", vetted: true, revoked: false },
  { merchantId: 'MER-002', name: 'QuickPay Kiosk', vetted: true, revoked: false },
  { merchantId: 'MER-003', name: 'PayZone CityMall', vetted: true, revoked: false },
];

const members: ConsortiumMember[] = SIGNERS.map((s) => ({
  signerId: s.signerId,
  name: s.name,
  org: s.org,
  identifier: s.identifier,
  status: 'ACTIVE' as const,
  bond: {
    posture: 'BONDED' as const,
    amountZar: 5_000_000,
    note: 'Conceptual performance bond (FRD §6.2-D): displayed, not enforced in the PoC.',
  },
}));

const governanceLog: GovernanceLogEntry[] = []; // newest first

export function getMerchant(merchantId: string): Merchant | undefined {
  return merchants.find((m) => m.merchantId === merchantId);
}

export function listMerchants(): Merchant[] {
  return [...merchants];
}

export function listMembers(): ConsortiumMember[] {
  return [...members];
}

export function isMemberActive(signerId: SignerId): boolean {
  return members.find((m) => m.signerId === signerId)?.status === 'ACTIVE';
}

export function addGovernanceEntry(action: string, subject: string, actor: string, detail?: string): void {
  governanceLog.unshift({ id: randomUUID(), at: now(), action, subject, actor, ...(detail ? { detail } : {}) });
  if (governanceLog.length > GOVLOG_CAP) governanceLog.pop();
  log('governance', { action, subject, actor, detail });
  broadcast({
    type: 'governance.updated',
    members: listMembers(),
    merchants: listMerchants(),
    governanceLog: [...governanceLog],
  });
}

export function setMerchantRevoked(merchantId: string, revoked: boolean, actor: string): Merchant | null {
  const m = getMerchant(merchantId);
  if (!m) return null;
  m.revoked = revoked;
  addGovernanceEntry(revoked ? 'MERCHANT_REVOKED' : 'MERCHANT_REINSTATED', merchantId, actor, m.name);
  return m;
}

export function setMemberStatus(signerId: SignerId, status: 'ACTIVE' | 'REVOKED', actor: string): ConsortiumMember | null {
  const m = members.find((x) => x.signerId === signerId);
  if (!m) return null;
  m.status = status;
  addGovernanceEntry(status === 'REVOKED' ? 'MEMBER_REVOKED' : 'MEMBER_REINSTATED', signerId, actor, m.name);
  emitConsortiumIfChanged(); // revoked overlay + quorumReachable may have changed
  return m;
}

// ---------------------------------------------------------------------------
// bank status (health poll + debit outcome window feed this)
// ---------------------------------------------------------------------------

let bankUp = false;
let bankMode: BankMode = 'CONFIRM';
let lastConfirmationAt: string | null = null;
const debitOutcomes: boolean[] = []; // last N attempts, true = confirmed
let lastBankJson = '';

export function getBankStatus(): BankStatus {
  const attempts = debitOutcomes.length;
  const confirmRatePct = attempts === 0 ? 100 : Math.round((100 * debitOutcomes.filter(Boolean).length) / attempts);
  return { up: bankUp, mode: bankMode, confirmRatePct, lastConfirmationAt };
}

function emitBankIfChanged(): void {
  const status = getBankStatus();
  const j = JSON.stringify(status);
  if (j !== lastBankJson) {
    lastBankJson = j;
    broadcast({ type: 'bank.status', bank: status });
  }
}

export function updateBankHealth(up: boolean, mode?: BankMode): void {
  bankUp = up;
  if (mode) bankMode = mode;
  emitBankIfChanged();
}

export function recordDebitAttempt(confirmed: boolean): void {
  debitOutcomes.push(confirmed);
  if (debitOutcomes.length > DEBIT_OUTCOME_WINDOW) debitOutcomes.shift();
  if (confirmed) lastConfirmationAt = now();
  emitBankIfChanged();
}

// ---------------------------------------------------------------------------
// consortium status (signer health poll feeds this; governance overlays revoked)
// ---------------------------------------------------------------------------

function offlineHealth(s: SignerInfo): SignerHealth {
  return {
    signerId: s.signerId,
    name: s.name,
    org: s.org,
    identifier: s.identifier,
    online: false,
    sharePresent: false,
    refuse: false,
    lastPartialAt: null,
    revoked: false,
  };
}

let signerHealthsRaw: SignerHealth[] = SIGNERS.map(offlineHealth);
let lastConsortiumJson = '';

export function getConsortiumStatus(): ConsortiumStatus {
  const signers = signerHealthsRaw.map((h) => ({
    ...h,
    revoked: !isMemberActive(h.signerId),
    // overlay the on-chain address from the manifest so it shows even when offline
    ...(h.xrplAddress ? {} : CONSORTIUM_CHAIN?.members[h.signerId] ? { xrplAddress: CONSORTIUM_CHAIN.members[h.signerId]!.address } : {}),
  }));
  const quorumReachable = signers.filter((s) => s.online && !s.revoked).length >= THRESHOLD.t;
  return {
    threshold: { t: THRESHOLD.t, n: THRESHOLD.n },
    groupPublicKey: GROUP.groupPublicKey,
    signers,
    quorumReachable,
    ...(CONSORTIUM_CHAIN ? { chain: CONSORTIUM_CHAIN } : {}),
  };
}

export function emitConsortiumIfChanged(): void {
  const consortium = getConsortiumStatus();
  const j = JSON.stringify(consortium);
  if (j !== lastConsortiumJson) {
    lastConsortiumJson = j;
    broadcast({ type: 'consortium.status', consortium });
  }
}

export function updateSignerHealths(healths: SignerHealth[]): void {
  signerHealthsRaw = healths;
  emitConsortiumIfChanged();
}

export function offlineSignerHealth(s: SignerInfo): SignerHealth {
  return offlineHealth(s);
}

// ---------------------------------------------------------------------------
// meters (simulated fleet, seeded MTR-1001..MTR-1006)
// ---------------------------------------------------------------------------

const meters = new Map<string, MeterState>(
  Array.from({ length: 6 }, (_, i) => {
    const meterId = `MTR-100${i + 1}`;
    return [meterId, { meterId, balanceKwh: 0, lastDispenseAt: null, dispenses: 0 }] as const;
  }),
);

export function creditMeter(meterId: string, amountKwh: number): MeterState {
  let meter = meters.get(meterId);
  if (!meter) {
    meter = { meterId, balanceKwh: 0, lastDispenseAt: null, dispenses: 0 };
    meters.set(meterId, meter);
  }
  meter.balanceKwh = Math.round((meter.balanceKwh + amountKwh) * 100) / 100;
  meter.dispenses += 1;
  meter.lastDispenseAt = now();
  broadcast({ type: 'meter.updated', meter });
  return meter;
}

export function listMeters(): MeterState[] {
  return [...meters.values()];
}

// ---------------------------------------------------------------------------
// audit trail (on-chain records, survives request eviction)
// ---------------------------------------------------------------------------

const audit: LedgerRecord[] = []; // newest first

export function addAudit(record: LedgerRecord): void {
  audit.unshift(record);
}

export function listAudit(): LedgerRecord[] {
  return [...audit];
}

// ---------------------------------------------------------------------------
// reconciliation (§3.4 — terminal states only; Δ must be 0 in honest operation)
// ---------------------------------------------------------------------------

const series: ReconciliationPoint[] = [];
let lastDelta = 0;

export function computeReconciliation(): Reconciliation {
  // Count tokens per delivered token but debits/records by DISTINCT debitRef /
  // tx hash (FR-12). This makes the Δ monitor able to see a "two tokens, one
  // debit" divergence: it would read tokens=2, debits=1 → Δ=1 (FR-D3), whereas
  // a naive per-request count would net to zero and hide exactly the fraud FR-20
  // targets. In honest operation every debitRef and tx is unique → Δ=0.
  let tokens = 0;
  const deliveredDebitRefs = new Set<string>();
  const deliveredTxHashes = new Set<string>();
  const stuckDebitRefs = new Set<string>(); // FR-21 reversal FAILED → money with no token
  for (const r of requests.values()) {
    if (!TERMINAL.has(r.status)) continue;
    if (r.status === 'DELIVERED') {
      if (r.token) tokens += 1;
      if (r.debit) deliveredDebitRefs.add(r.debit.debitRef);
      if (r.ledger) deliveredTxHashes.add(r.ledger.txHash);
    } else if (r.status === 'REJECTED_ABANDONED') {
      // contributes nothing when the FR-21 reversal succeeded; a failed reversal
      // leaves a confirmed debit with no token → divergence (FR-D3)
      if (r.debit && !r.debitReversed) stuckDebitRefs.add(r.debit.debitRef);
    }
    // REJECTED → nothing (no funds moved, no token, no record)
  }
  // distinct confirmed debits still backing value: delivered ∪ stuck-unreversed
  for (const ref of deliveredDebitRefs) stuckDebitRefs.delete(ref);
  const debits = deliveredDebitRefs.size + stuckDebitRefs.size;
  const records = deliveredTxHashes.size;
  const delta = Math.max(Math.abs(tokens - debits), Math.abs(tokens - records));
  return { tokensIssued: tokens, confirmedDebits: debits, onChainRecords: records, delta, series: [...series] };
}

function onTerminal(status: RequestStatus): void {
  let rec = computeReconciliation();
  if (status === 'DELIVERED') {
    series.push({ t: now(), tokens: rec.tokensIssued, debits: rec.confirmedDebits, records: rec.onChainRecords });
    if (series.length > SERIES_CAP) series.shift();
    rec = { ...rec, series: [...series] };
  }
  broadcast({ type: 'reconciliation', reconciliation: rec });
  if (rec.delta !== 0 && rec.delta !== lastDelta) {
    addAlert({
      severity: 'critical',
      title: 'Reconciliation divergence: Δ ≠ 0',
      message: `tokens=${rec.tokensIssued} debits=${rec.confirmedDebits} records=${rec.onChainRecords} (Δ=${rec.delta}). Honest operation makes divergence impossible; this indicates a system fault or tampering (FR-D3).`,
      attribution: 'reconciliation',
    });
  }
  lastDelta = rec.delta;
}

// ---------------------------------------------------------------------------
// demo state + snapshot
// ---------------------------------------------------------------------------

let activeScenario: string | null = null;

export function setActiveScenario(kind: string | null): void {
  activeScenario = kind;
}

export function buildSnapshot(): Snapshot {
  return {
    requests: listRequests(),
    bank: getBankStatus(),
    consortium: getConsortiumStatus(),
    reconciliation: computeReconciliation(),
    alerts: [...alerts],
    members: listMembers(),
    merchants: listMerchants(),
    governanceLog: [...governanceLog],
    meters: listMeters(),
    demo: { activeScenario },
  };
}
