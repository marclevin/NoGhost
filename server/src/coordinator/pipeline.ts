/**
 * The Two-Walls pipeline (CONTRACTS.md §3.1, FR-15 strict order):
 *
 *   PENDING → bank debit → DEBIT_CONFIRMED → FROST ceremony → SIGNED
 *           → XRPL memo → RECORDED → meter delivery → DELIVERED
 *
 * plus the failure semantics that make insider fraud impossible by construction:
 *   FR-3  coordinator independently verifies the bank attestation signature
 *   FR-16 idempotent on requestId (enforced in index.ts before we run)
 *   FR-17 every request reaches a terminal state — the whole run is wrapped
 *   FR-20 one debit, one token (consumed debitRef registry)
 *   FR-21 any post-debit failure → reverse the debit → REJECTED_ABANDONED
 */
import { bytesToHex, canonicalBytes, hashValue, hexToBytes, sha256Hex } from '../common/canonical.js';
import { ed25519 } from '@noble/curves/ed25519';
import { BANK_URL, CURRENCY, SIGNERS, THRESHOLD, priceZar, signerUrl, type SignerInfo } from '../common/config.js';
import { buildTokenPayload } from '../common/token.js';
import { aggregate, verifySignature, verifySignatureShare, type Commitment } from '../frost/frost.js';
import type {
  DebitConfirmation,
  DebitRequest,
  DebitSignedPayload,
  LedgerRecord,
  PipelineRecord,
  Round2Request,
  SignerId,
  Token,
  TokenPayload,
  Wall,
} from '../common/types.js';
import { tryFetchJson } from './http.js';
import { deliverToken, verifyTokenForMeter } from './meter.js';
import * as store from './store.js';
import { submitAuthorisation } from './xrpl.js';

const now = () => new Date().toISOString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// terminal-state helpers
// ---------------------------------------------------------------------------

/** Pre-debit rejection — no funds ever moved. */
function reject(record: PipelineRecord, wall: Wall, reason: string, attribution: string): void {
  record.rejection = { wall, reason, at: now(), attribution };
  store.transition(record, 'REJECTED', reason);
}

/** FR-21 — post-debit failure: reverse the debit at the bank, then abandon. Never throws. */
async function abandon(record: PipelineRecord, wall: Wall, reason: string, attribution: string): Promise<void> {
  let reversed = false;
  const debitRef = record.debit?.debitRef;
  if (debitRef) {
    try {
      const r = await tryFetchJson(`${BANK_URL}/api/debits/${debitRef}/reverse`, { method: 'POST' }, 3000);
      reversed = r?.ok === true;
    } catch {
      reversed = false;
    }
  }
  record.debitReversed = reversed;
  record.rejection = { wall, reason, at: now(), attribution };
  store.addAlert({
    severity: reversed ? 'warning' : 'critical',
    wall,
    requestId: record.request.requestId,
    title: reversed
      ? 'Request abandoned — debit reversed, customer refunded'
      : 'Request abandoned — DEBIT REVERSAL FAILED',
    message: reversed
      ? `${reason}. The confirmed debit ${debitRef ?? ''} was reversed at the bank; no token exists (FR-21).`
      : `${reason}. Reversal of ${debitRef ?? 'the debit'} could not be confirmed — manual reconciliation required.`,
    attribution,
  });
  store.transition(record, 'REJECTED_ABANDONED', reversed ? `${reason} — debit reversed` : `${reason} — debit reversal FAILED`);
}

// ---------------------------------------------------------------------------
// Wall 1 helpers
// ---------------------------------------------------------------------------

/** FR-3: the coordinator's own verification of the bank attestation (pinned key). */
function verifyBankSignature(debit: DebitConfirmation): boolean {
  try {
    const payload: DebitSignedPayload = {
      debitRef: debit.debitRef,
      requestId: debit.requestId,
      meterId: debit.meterId,
      amountKwh: debit.amountKwh,
      amount: debit.amount,
      currency: debit.currency,
      confirmedAt: debit.confirmedAt,
    };
    return ed25519.verify(hexToBytes(debit.bankSignature), canonicalBytes(payload), hexToBytes(store.BANK_PUBLIC_KEY));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wall 2 helpers
// ---------------------------------------------------------------------------

async function signerIsOnline(s: SignerInfo): Promise<boolean> {
  const r = await tryFetchJson(`${signerUrl(s)}/api/health`, {}, 1500);
  return r?.ok === true && r.body?.online === true;
}

/** Health-poll every non-revoked consortium member; return the online ones, by identifier. */
async function pollOnlineActiveSigners(): Promise<SignerInfo[]> {
  const active = SIGNERS.filter((s) => store.isMemberActive(s.signerId));
  const online: SignerInfo[] = [];
  await Promise.all(
    active.map(async (s) => {
      if (await signerIsOnline(s)) online.push(s);
    }),
  );
  return online.sort((a, b) => a.identifier - b.identifier);
}

type CeremonyOutcome =
  | { kind: 'ok'; token: Token; signerSet: SignerId[] }
  | { kind: 'refused'; signerId: SignerId; reason?: string }
  | { kind: 'error'; reason: string; badSigner?: SignerId };

/** One full FROST 2-round ceremony with a fixed participant set. */
async function runCeremony(
  record: PipelineRecord,
  chosen: SignerInfo[],
  tokenPayload: TokenPayload,
  message: Uint8Array,
  messageHex: string,
): Promise<CeremonyOutcome> {
  const requestId = record.request.requestId;

  // round 1 — collect commitments
  const commitments: Commitment[] = [];
  const round1Results = await Promise.all(
    chosen.map((s) =>
      tryFetchJson(`${signerUrl(s)}/api/ceremony/round1`, { method: 'POST', body: JSON.stringify({ sessionId: requestId }) }, 3000),
    ),
  );
  for (let i = 0; i < chosen.length; i++) {
    const s = chosen[i];
    const r = round1Results[i];
    if (!r?.ok || !r.body?.commitment?.hiding || !r.body?.commitment?.binding) {
      return { kind: 'error', reason: `ROUND1_FAILED (${s.signerId}${r ? `: ${r.status}` : ': unreachable'})` };
    }
    commitments.push({ identifier: s.identifier, hiding: r.body.commitment.hiding, binding: r.body.commitment.binding });
  }

  // round 2 — collect and independently verify each partial signature
  const round2Req: Round2Request = {
    sessionId: requestId,
    messageHex,
    tokenPayload,
    request: record.request,
    debit: record.debit!,
    commitments,
  };
  const shares: Array<{ identifier: number; zi: string }> = [];
  for (const s of chosen) {
    const r = await tryFetchJson(`${signerUrl(s)}/api/ceremony/round2`, { method: 'POST', body: JSON.stringify(round2Req) }, 5000);
    if (!r) return { kind: 'error', reason: `ROUND2_UNREACHABLE (${s.signerId})` };
    if (r.status === 403 && r.body?.refused) {
      return { kind: 'refused', signerId: s.signerId, reason: r.body?.reason };
    }
    if (!r.ok || typeof r.body?.zi !== 'string') {
      return { kind: 'error', reason: `ROUND2_FAILED (${s.signerId}: ${r.status}${r.body?.error ? ` ${r.body.error}` : ''})` };
    }
    const verificationShare = store.GROUP.verificationShares[String(s.identifier)];
    const share = { identifier: s.identifier, zi: r.body.zi as string };
    if (!verifySignatureShare(share, verificationShare, commitments, store.GROUP.groupPublicKey, message)) {
      // attribution: this specific signer produced a bad partial (RFC 9591 §5.3)
      return { kind: 'error', reason: `BAD_PARTIAL_SIGNATURE (${s.signerId})`, badSigner: s.signerId };
    }
    shares.push(share);
  }

  // aggregate + sanity-verify against the group public key
  let signature: string;
  try {
    signature = aggregate(commitments, shares, store.GROUP.groupPublicKey, message).signature;
  } catch (e) {
    return { kind: 'error', reason: `AGGREGATION_FAILED: ${errMsg(e)}` };
  }
  if (!verifySignature(signature, message, store.GROUP.groupPublicKey)) {
    return { kind: 'error', reason: 'AGGREGATE_SIGNATURE_INVALID' };
  }
  return { kind: 'ok', token: { ...tokenPayload, signature }, signerSet: chosen.map((s) => s.signerId) };
}

// ---------------------------------------------------------------------------
// the pipeline
// ---------------------------------------------------------------------------

export async function runPipeline(record: PipelineRecord): Promise<void> {
  const { requestId, merchantId, meterId, amountKwh } = record.request;
  let stage: Wall = 'POLICY';
  try {
    // ---- 1. policy gate (FR-19) -------------------------------------------
    const merchant = store.getMerchant(merchantId);
    if (!merchant) {
      store.addAlert({
        severity: 'warning',
        wall: 'POLICY',
        requestId,
        title: 'Unknown merchant blocked',
        message: `Merchant ${merchantId} is not registered — request rejected before any funds movement.`,
        attribution: merchantId,
      });
      return reject(record, 'POLICY', `UNKNOWN_MERCHANT (${merchantId})`, merchantId);
    }
    if (merchant.revoked) {
      store.addAlert({
        severity: 'warning',
        wall: 'POLICY',
        requestId,
        title: 'Revoked merchant blocked',
        message: `Merchant ${merchant.name} (${merchantId}) is revoked — request rejected (FR-19).`,
        attribution: merchantId,
      });
      return reject(record, 'POLICY', `MERCHANT_REVOKED (${merchant.name})`, merchantId);
    }

    // ---- 2. pre-flight quorum availability (fail fast, BEFORE any debit) ----
    // FR-2 forbids signing before a confirmed debit, but nothing stops us from
    // declining to take the customer's money when we already know Wall 2 cannot
    // form a quorum. This gives a clean "rejected at Wall 2, no funds moved"
    // outcome; the post-debit below-threshold path below remains as the race
    // backstop (a signer dropping mid-flight → FR-21 reversal).
    stage = 'WALL_2_CONSORTIUM';
    const preflight = await pollOnlineActiveSigners();
    if (preflight.length < THRESHOLD.t) {
      store.addAlert({
        severity: 'warning',
        wall: 'WALL_2_CONSORTIUM',
        requestId,
        title: 'Quorum unreachable — blocked at Wall 2 (no debit taken)',
        message: `Only ${preflight.length} of ${SIGNERS.length} consortium signers available; ${THRESHOLD.t} are required. The customer was not charged — no single insider can generate.`,
        attribution: 'consortium',
      });
      return reject(
        record,
        'WALL_2_CONSORTIUM',
        `BELOW_THRESHOLD (${preflight.length} of ${SIGNERS.length} signers available, need ${THRESHOLD.t})`,
        'consortium',
      );
    }

    // ---- 3. Wall 1 — bank-confirmed debit ---------------------------------
    stage = 'WALL_1_BANK';
    const debitRequest: DebitRequest = {
      requestId,
      merchantId,
      meterId,
      amountKwh,
      amount: priceZar(amountKwh),
      currency: CURRENCY,
    };
    // 10s budget: must outlast the bank's 8s TIMEOUT demo mode
    const bankResp = await tryFetchJson(`${BANK_URL}/api/debits`, { method: 'POST', body: JSON.stringify(debitRequest) }, 10_000);

    if (!bankResp) {
      store.recordDebitAttempt(false);
      store.updateBankHealth(false);
      store.addAlert({
        severity: 'warning',
        wall: 'WALL_1_BANK',
        requestId,
        title: 'Bank unreachable — blocked at Wall 1',
        message: 'No confirmed debit could be obtained; without one no token can exist.',
        attribution: merchantId,
      });
      return reject(record, 'WALL_1_BANK', 'BANK_UNREACHABLE', merchantId);
    }
    store.updateBankHealth(true);
    if (!bankResp.ok) {
      store.recordDebitAttempt(false);
      const reason =
        bankResp.status === 402
          ? `DEBIT_DECLINED${bankResp.body?.reason ? `: ${bankResp.body.reason}` : ''}`
          : bankResp.status === 504
            ? 'BANK_TIMEOUT'
            : `BANK_ERROR (${bankResp.status})`;
      // decline/timeout means a non-CONFIRM bank mode caused it → the headline moment
      store.addAlert({
        severity: 'critical',
        wall: 'WALL_1_BANK',
        requestId,
        title: 'Ghost-vend attempt blocked at Wall 1',
        message: `The bank did not confirm the debit (${reason}). No funds moved — no token will ever exist for this request.`,
        attribution: merchantId,
      });
      return reject(record, 'WALL_1_BANK', reason, merchantId);
    }

    const debit = bankResp.body as DebitConfirmation;
    // FR-3 — independent verification of the bank attestation with the pinned key
    if (!verifyBankSignature(debit) || debit.requestId !== requestId) {
      store.recordDebitAttempt(false);
      store.addAlert({
        severity: 'critical',
        wall: 'WALL_1_BANK',
        requestId,
        title: 'Ghost-vend attempt blocked at Wall 1',
        message: 'The bank attestation failed independent signature verification (FR-3) — forged or absent confirmation.',
        attribution: merchantId,
      });
      return reject(record, 'WALL_1_BANK', 'BANK_SIGNATURE_INVALID', merchantId);
    }
    store.recordDebitAttempt(true);
    record.debit = debit;

    // FR-20 — one debit, one token
    const claim = store.claimDebitRef(debit.debitRef, requestId);
    if (!claim.ok) {
      store.addAlert({
        severity: 'critical',
        wall: 'POLICY',
        requestId,
        title: 'Debit replay blocked — one debit, one token',
        message: `debitRef ${debit.debitRef} was already consumed by request ${claim.byRequestId} (FR-20).`,
        attribution: merchantId,
      });
      return reject(record, 'POLICY', 'DEBIT_ALREADY_CONSUMED', merchantId);
    }
    store.transition(record, 'DEBIT_CONFIRMED', `debitRef ${debit.debitRef} — R${debit.amount} confirmed & verified`);

    // ---- 4. Wall 2 — FROST threshold ceremony -----------------------------
    stage = 'WALL_2_CONSORTIUM';
    const online = await pollOnlineActiveSigners();

    if (online.length < THRESHOLD.t) {
      // Race backstop: quorum was reachable at pre-flight but a signer dropped
      // after the debit was confirmed. Debit is already taken → FR-21 reversal.
      store.addAlert({
        severity: 'warning',
        wall: 'WALL_2_CONSORTIUM',
        requestId,
        title: 'Quorum lost mid-flight — blocked at Wall 2',
        message: `Only ${online.length} of ${SIGNERS.length} consortium signers available; ${THRESHOLD.t} are required. No single insider can generate; the confirmed debit will be reversed.`,
        attribution: 'consortium',
      });
      return await abandon(
        record,
        'WALL_2_CONSORTIUM',
        `BELOW_THRESHOLD (${online.length} of ${SIGNERS.length} signers available, need ${THRESHOLD.t})`,
        'consortium',
      );
    }

    // The token is the ONE payload this bank-signed debit authorises (FR-20 at
    // Wall 2): meterId/amountKwh/debitRef from the debit, nonce = H(debitRef).
    // Each signer re-derives and verifies this identically before signing.
    const tokenPayload: TokenPayload = buildTokenPayload(debit);
    const message = canonicalBytes(tokenPayload);
    const messageHex = bytesToHex(message);

    const refused = new Set<SignerId>();
    let token: Token | null = null;
    let signerSet: SignerId[] = [];
    while (!token) {
      const pool = online.filter((s) => !refused.has(s.signerId));
      if (pool.length < THRESHOLD.t) {
        return await abandon(
          record,
          'WALL_2_CONSORTIUM',
          `SIGNERS_REFUSED (${[...refused].join(', ')}) — no spare signer available`,
          [...refused].join(', ') || 'consortium',
        );
      }
      const chosen = pool.slice(0, THRESHOLD.t);
      const outcome = await runCeremony(record, chosen, tokenPayload, message, messageHex);
      if (outcome.kind === 'refused') {
        // FR-9 — attributable governance refusal; swap in the spare and retry
        refused.add(outcome.signerId);
        store.addGovernanceEntry('SIGNER_REFUSED', outcome.signerId, outcome.signerId, outcome.reason ?? `request ${requestId}`);
        store.addAlert({
          severity: 'warning',
          wall: 'WALL_2_CONSORTIUM',
          requestId,
          title: `Signer refused to sign: ${outcome.signerId}`,
          message: `${outcome.reason ?? 'No reason given'} — refusal logged attributably; trying spare signer.`,
          attribution: outcome.signerId,
        });
        continue;
      }
      if (outcome.kind === 'error') {
        if (outcome.badSigner) {
          store.addAlert({
            severity: 'critical',
            wall: 'WALL_2_CONSORTIUM',
            requestId,
            title: `Invalid partial signature from ${outcome.badSigner}`,
            message: 'The partial signature failed share verification — misbehaviour is attributable to this signer.',
            attribution: outcome.badSigner,
          });
        }
        return await abandon(record, 'WALL_2_CONSORTIUM', outcome.reason, outcome.badSigner ?? 'consortium');
      }
      token = outcome.token;
      signerSet = outcome.signerSet;
    }
    record.token = token;
    record.signerSet = signerSet;
    store.transition(record, 'SIGNED', `quorum ${signerSet.join(' + ')} (${THRESHOLD.t}-of-${THRESHOLD.n})`);

    // ---- 5. meter pre-verification (BEFORE the immutable write) ------------
    // Validate the token against the meter (signature + not-yet-redeemed) with
    // no state change, so a token the meter would reject never leaves an orphan
    // record on the public ledger. In honest operation this always passes (the
    // aggregate was just verified); it is a consistency guard, not a happy path.
    const preMeter = verifyTokenForMeter(token);
    if (!preMeter.ok) {
      return await abandon(record, 'WALL_2_CONSORTIUM', preMeter.reason, `meter ${meterId}`);
    }

    // ---- 6. ledger — XRPL immutable witness --------------------------------
    stage = 'LEDGER';
    let ledger: LedgerRecord;
    try {
      ledger = await submitAuthorisation({
        requestHash: hashValue(record.request),
        debitRefHash: sha256Hex(debit.debitRef),
        tokenHash: hashValue(token),
        signerSet,
      });
    } catch (e) {
      return await abandon(record, 'LEDGER', `XRPL_SUBMIT_FAILED: ${errMsg(e)}`, 'xrpl-testnet');
    }
    record.ledger = ledger;
    store.addAudit(ledger);
    store.transition(record, 'RECORDED', `tx ${ledger.txHash}`);

    // ---- 7. meter delivery — closes the loop -------------------------------
    // Pre-verified above, so this commit cannot fail in honest operation.
    const delivery = deliverToken(token);
    if (!delivery.ok) {
      return await abandon(record, 'WALL_2_CONSORTIUM', delivery.reason, `meter ${meterId}`);
    }
    record.meterDelivery = { verified: true, dispensedKwh: token.amountKwh, at: now() };
    store.transition(record, 'DELIVERED', `meter ${meterId} verified token & credited ${amountKwh} kWh`);
  } catch (err) {
    // ---- FR-17 backstop: no unhandled rejection leaves a request non-terminal
    store.log('pipeline.error', { requestId, stage, error: errMsg(err) });
    if (!store.TERMINAL.has(record.status)) {
      const reason = `INTERNAL_ERROR: ${errMsg(err)}`;
      if (record.debit) await abandon(record, stage, reason, 'coordinator');
      else reject(record, stage, reason, 'coordinator');
    }
  }
}
