/**
 * Signer service — one consortium member of Wall 2 (CONTRACTS.md §2).
 * Started as `tsx src/signer/index.ts <signerId>`; port from SIGNERS registry
 * (utility 4201 / city-a 4202 / city-b 4203).
 *
 * Security posture (FR-8): the bank public key is PINNED from
 * keys/bank.pub.json at boot — a trust anchor provisioned out-of-band, never
 * taken from the coordinator. Every round-2 request is independently verified
 * here before this member contributes its partial signature.
 */
import express from 'express';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Wallet, SubmittableTransaction } from 'xrpl';
import { KEYS_DIR, SIGNERS, XRPL_MULTISIGN_QUORUM } from '../common/config.js';
import { hexToBytes, hashValue } from '../common/canonical.js';
import { round1, round2Sign } from '../frost/frost.js';
import {
  loadMemberWallet,
  readRequestTx,
  postApproval,
  readApprovals,
  signReceiptFragment,
} from '../common/chain.js';
import type { DebitConfirmation, GenerationRequest, Round1Response, Round2Request, Round2Response, SignerHealth, SignerId } from '../common/types.js';
import { runWall1TokenChecks, validateDebitForRequest } from './verify.js';

// --- identity ----------------------------------------------------------------
const signerId = process.argv[2] as SignerId | undefined;
const info = SIGNERS.find((s) => s.signerId === signerId);
if (!info) {
  console.error(`usage: tsx src/signer/index.ts <${SIGNERS.map((s) => s.signerId).join('|')}>`);
  process.exit(1);
}

const log = (evt: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), svc: `signer:${info.signerId}`, evt, ...extra }));

// --- keys (loaded once at boot; degrade gracefully if absent, FR-D2) ---------
interface ShareFile {
  signerId: SignerId;
  identifier: number;
  secretShare: string;
  verificationShare: string;
  groupPublicKey: string;
}
let share: ShareFile | null = null;
try {
  share = JSON.parse(readFileSync(resolve(KEYS_DIR, `signer-${info.signerId}.json`), 'utf8')) as ShareFile;
} catch (e) {
  log('share.load_failed', { err: String(e) });
}

/** PINNED bank public key (FR-8) — read at boot, never updated at runtime. */
let pinnedBankPublicKey: string | null = null;
try {
  pinnedBankPublicKey = (JSON.parse(readFileSync(resolve(KEYS_DIR, 'bank.pub.json'), 'utf8')) as { publicKey: string })
    .publicKey;
} catch (e) {
  log('bank_pubkey.load_failed', { err: String(e) });
}

/** This member's own XRPL wallet (posts approvals + signs receipt fragments). */
let xrplWallet: Wallet | null = null;
try {
  xrplWallet = loadMemberWallet(info.signerId);
} catch (e) {
  log('xrpl_wallet.load_failed', { err: String(e) });
}
/** requestHashes this member has already endorsed on-chain (idempotent approvals). */
const approvedOnChain = new Map<string, { verdict: 'APPROVE' | 'REJECT'; txHash: string }>();

// --- state --------------------------------------------------------------------
let online = true; // demo toggle
let refuse = false; // FR-9 governance flag
let refuseReason: string | undefined;
let lastPartialAt: string | null = null;

interface Session {
  nonces: { hiding: string; binding: string }; // PRIVATE, single-use
  createdAt: number;
}
const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 5 * 60 * 1000;

function sweepExpiredSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) {
      sessions.delete(id);
      log('session.expired', { sessionId: id });
    }
  }
}
setInterval(sweepExpiredSessions, 60_000).unref();

// --- app -----------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  const health: SignerHealth = {
    signerId: info.signerId,
    name: info.name,
    org: info.org,
    identifier: info.identifier,
    online,
    sharePresent: share !== null,
    refuse,
    lastPartialAt,
    revoked: false, // governance overlay is the coordinator's job
    ...(xrplWallet ? { xrplAddress: xrplWallet.address } : {}),
  };
  res.json(health);
});

app.post('/api/admin/online', (req, res) => {
  const next = (req.body as { online?: unknown } | undefined)?.online;
  if (typeof next !== 'boolean') {
    res.status(400).json({ error: 'online must be a boolean' });
    return;
  }
  online = next;
  log('admin.online', { online });
  res.json({ online });
});

app.post('/api/admin/refuse', (req, res) => {
  const body = req.body as { refuse?: unknown; reason?: unknown } | undefined;
  if (typeof body?.refuse !== 'boolean') {
    res.status(400).json({ error: 'refuse must be a boolean' });
    return;
  }
  refuse = body.refuse;
  refuseReason = typeof body.reason === 'string' ? body.reason : undefined;
  log('admin.refuse', { refuse, reason: refuseReason });
  res.json({ refuse, reason: refuseReason ?? null });
});

// --- ceremony round 1: commit -----------------------------------------------
app.post('/api/ceremony/round1', (req, res) => {
  if (!online) {
    res.status(503).json({ error: 'signer offline' });
    return;
  }
  if (!share) {
    res.status(503).json({ error: 'secret share unavailable' });
    return;
  }
  const sessionId = (req.body as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    res.status(400).json({ error: 'sessionId required' });
    return;
  }
  sweepExpiredSessions();
  const out = round1(share.secretShare); // nonces stay HERE; only commitments leave
  sessions.set(sessionId, { nonces: out.nonces, createdAt: Date.now() });
  log('round1.committed', { sessionId });
  const response: Round1Response = { signerId: info.signerId, identifier: info.identifier, commitment: out.commitment };
  res.json(response);
});

// --- on-chain consensus: read request from chain, validate, post own approval -
// The member does NOT trust the coordinator's word: it reads the encrypted
// request from the ledger, decrypts it, verifies the bank attestation itself,
// and posts its OWN signed APPROVE/REJECT transaction from its OWN XRPL account.
app.post('/api/consensus/validate', async (req, res) => {
  if (!online) {
    res.status(503).json({ error: 'signer offline' });
    return;
  }
  if (!share || !pinnedBankPublicKey || !xrplWallet) {
    res.status(503).json({ error: 'signer keys unavailable' });
    return;
  }
  const requestTxHash = (req.body as { requestTxHash?: unknown } | undefined)?.requestTxHash;
  if (typeof requestTxHash !== 'string' || requestTxHash.length === 0) {
    res.status(400).json({ error: 'requestTxHash required' });
    return;
  }
  try {
    const read = await readRequestTx<{ request: GenerationRequest; debit: DebitConfirmation }>(requestTxHash);
    if (!read) {
      res.status(400).json({ error: 'REQUEST_NOT_ON_CHAIN' });
      return;
    }
    const { requestHash, payload } = read;

    // idempotent — never post two attestations for one request
    const prior = approvedOnChain.get(requestHash);
    if (prior) {
      res.json({ signerId: info.signerId, verdict: prior.verdict, txHash: prior.txHash, requestHash, cached: true });
      return;
    }

    // independent validation: on-chain id binds the request; FR-9 refusal; Wall-1 debit checks
    let verdict: 'APPROVE' | 'REJECT' = 'APPROVE';
    let reason: string | undefined;
    if (hashValue(payload.request) !== requestHash) {
      verdict = 'REJECT';
      reason = 'REQUEST_HASH_MISMATCH';
    } else if (refuse) {
      verdict = 'REJECT';
      reason = `GOVERNANCE_REFUSAL${refuseReason ? `: ${refuseReason}` : ''}`;
    } else {
      const failure = validateDebitForRequest(payload.request, payload.debit, pinnedBankPublicKey);
      if (failure) {
        verdict = 'REJECT';
        reason = failure.body.error;
      }
    }

    const { txHash } = await postApproval(xrplWallet, info.signerId, requestHash, verdict, reason);
    approvedOnChain.set(requestHash, { verdict, txHash });
    log('consensus.attested', { requestHash, verdict, reason, txHash });
    res.json({ signerId: info.signerId, verdict, reason, txHash, requestHash });
  } catch (e) {
    log('consensus.validate_error', { err: String((e as Error)?.message ?? e) });
    res.status(500).json({ error: 'validate failed', detail: String((e as Error)?.message ?? e) });
  }
});

/** Count on-chain APPROVE attestations for a request, with brief retry for ledger propagation. */
async function onChainApproveCount(requestHash: string): Promise<number> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const approvals = await readApprovals(requestHash);
    const n = approvals.filter((a) => a.verdict === 'APPROVE').length;
    if (n >= XRPL_MULTISIGN_QUORUM || attempt === 3) return n;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return 0;
}

// --- on-chain multisign receipt: co-sign a fragment (2-of-3) ------------------
app.post('/api/consensus/sign-receipt', async (req, res) => {
  if (!online) {
    res.status(503).json({ error: 'signer offline' });
    return;
  }
  if (!xrplWallet) {
    res.status(503).json({ error: 'signer XRPL key unavailable' });
    return;
  }
  const body = req.body as { prepared?: SubmittableTransaction; requestHash?: unknown } | undefined;
  if (!body?.prepared || typeof body.requestHash !== 'string') {
    res.status(400).json({ error: 'prepared tx and requestHash required' });
    return;
  }
  // a member only co-signs a receipt for a request that reached on-chain quorum
  const approveCount = await onChainApproveCount(body.requestHash);
  if (approveCount < XRPL_MULTISIGN_QUORUM) {
    res.status(409).json({ error: 'NO_ONCHAIN_QUORUM', approveCount });
    return;
  }
  try {
    const fragment = signReceiptFragment(xrplWallet, body.prepared);
    log('consensus.receipt_signed', { requestHash: body.requestHash });
    res.json({ signerId: info.signerId, fragment });
  } catch (e) {
    res.status(500).json({ error: 'fragment signing failed', detail: String((e as Error)?.message ?? e) });
  }
});

// --- ceremony round 2: verify EVERYTHING, then sign ---------------------------
app.post('/api/ceremony/round2', async (req, res) => {
  if (!online) {
    res.status(503).json({ error: 'signer offline' });
    return;
  }
  sweepExpiredSessions();
  const body = req.body as Partial<Round2Request> | undefined;

  // 1. FR-9 governance refusal — attributable to this signer. Consume the
  //    session's single-use nonces even though we did not sign (no reuse, no leak).
  if (refuse) {
    if (typeof body?.sessionId === 'string') sessions.delete(body.sessionId);
    log('round2.refused', { sessionId: body?.sessionId, reason: refuseReason });
    res.status(403).json({ refused: true, signerId: info.signerId, reason: refuseReason ?? 'refusing to sign' });
    return;
  }

  // 2. Round 1 must have happened for this session.
  if (!body || typeof body.sessionId !== 'string') {
    res.status(400).json({ error: 'unknown session' });
    return;
  }
  const sessionId = body.sessionId;
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(400).json({ error: 'unknown session' });
    return;
  }

  if (!share || !pinnedBankPublicKey) {
    res.status(503).json({ error: 'signer keys unavailable' });
    return;
  }
  if (
    typeof body.messageHex !== 'string' ||
    typeof body.debit !== 'object' || body.debit === null ||
    typeof body.request !== 'object' || body.request === null ||
    typeof body.tokenPayload !== 'object' || body.tokenPayload === null ||
    !Array.isArray(body.commitments)
  ) {
    res.status(400).json({ error: 'invalid Round2Request' });
    return;
  }

  // 3–6. Independent Wall-1 + token verification (see verify.ts). A session that
  //    has been presented for signing is consumed regardless of pass/fail — its
  //    single-use nonces must not linger on a failure path (bounded memory; the
  //    coordinator opens a fresh session for any legitimate retry).
  const failure = runWall1TokenChecks(body as Round2Request, pinnedBankPublicKey);
  if (failure) {
    sessions.delete(sessionId);
    log('round2.check_failed', { sessionId, error: failure.body.error, detail: failure.body.detail });
    res.status(failure.status).json(failure.body);
    return;
  }

  // 6.5. LOAD-BEARING on-chain gate — the FROST partial is withheld unless an
  //      independent quorum of members has posted APPROVE attestations on-chain.
  //      This ties Wall 2 to the ledger: a compromised coordinator cannot induce
  //      signing without a genuine, publicly-visible consortium approval.
  const requestHash = hashValue((body as Round2Request).request);
  const approveCount = await onChainApproveCount(requestHash);
  if (approveCount < XRPL_MULTISIGN_QUORUM) {
    sessions.delete(sessionId);
    log('round2.no_onchain_quorum', { sessionId, requestHash, approveCount });
    res.status(409).json({ error: 'NO_ONCHAIN_QUORUM', detail: `only ${approveCount} on-chain approvals; need ${XRPL_MULTISIGN_QUORUM}` });
    return;
  }

  // 7. All good → produce the partial signature. Nonces are single-use:
  //    the session is deleted whether signing succeeds or throws.
  try {
    const { zi } = round2Sign({
      identifier: info.identifier,
      secretShare: share.secretShare,
      nonces: session.nonces,
      message: hexToBytes(body.messageHex),
      commitments: body.commitments,
      groupPublicKey: share.groupPublicKey,
    });
    lastPartialAt = new Date().toISOString();
    log('round2.signed', { sessionId });
    const response: Round2Response = { signerId: info.signerId, identifier: info.identifier, zi };
    res.json(response);
  } catch (e) {
    log('round2.sign_failed', { sessionId, err: String((e as Error)?.message ?? e) });
    res.status(500).json({ error: 'signing failed', detail: String((e as Error)?.message ?? e) });
  } finally {
    sessions.delete(sessionId);
  }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log('http.error', { err: String(err?.message ?? err) });
  if (!res.headersSent) res.status(err?.name === 'SyntaxError' ? 400 : 500).json({ error: 'internal error' });
});

// FR-D2: never crash the demo on a stray async failure.
process.on('uncaughtException', (e) => log('uncaught_exception', { err: String(e) }));
process.on('unhandledRejection', (e) => log('unhandled_rejection', { err: String(e) }));

app.listen(info.port, () =>
  log('listening', {
    port: info.port,
    identifier: info.identifier,
    sharePresent: share !== null,
    bankKeyPinned: pinnedBankPublicKey !== null,
  }),
);
