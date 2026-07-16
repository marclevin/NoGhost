/**
 * On-chain consortium primitives (native XRPL, no smart contracts).
 *
 * The "authority" account is the consortium's on-chain inbox/ledger: the request,
 * the members' independent approvals, and the final multisigned receipt all route
 * through it, so a single `account_tx` scan reconstructs the whole consensus.
 *
 *   - Requests are published as ciphertext (AES-256-GCM under the shared
 *     consortium key) so the public ledger carries no PII (NFR-3), plus a hash.
 *   - Each member posts its own APPROVE/REJECT attestation, signed by its own
 *     XRPL key — genuine, attributable multi-party endorsement on-chain.
 *   - The receipt is a 2-of-3 XRPL MULTISIGN transaction on the authority account
 *     (whose master key is disabled), so the ledger itself enforces the quorum.
 *
 * This module holds no secrets at rest; wallets are passed in by the caller.
 */
import { readFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Client, Wallet, multisign, convertStringToHex, convertHexToString, type SubmittableTransaction } from 'xrpl';
import { CONSORTIUM_MANIFEST, CONSORTIUM_ENC_KEY_FILE, xrplMemberKeyFile, XRPL_WSS, XRPL_EXPLORER_TX } from './config.js';
import type { SignerId } from './types.js';

// ---------------------------------------------------------------------------
// manifest + key material
// ---------------------------------------------------------------------------

export interface ConsortiumManifest {
  network: string;
  authority: string;
  quorum: number;
  masterKeyDisabled: boolean;
  members: Record<SignerId, string>;
  createdAt: string;
}

let manifestCache: ConsortiumManifest | null = null;
export function loadManifest(): ConsortiumManifest {
  if (!manifestCache) manifestCache = JSON.parse(readFileSync(CONSORTIUM_MANIFEST, 'utf8')) as ConsortiumManifest;
  return manifestCache;
}

let encKeyCache: Buffer | null = null;
function encKey(): Buffer {
  if (!encKeyCache) {
    const { key } = JSON.parse(readFileSync(CONSORTIUM_ENC_KEY_FILE, 'utf8')) as { key: string };
    encKeyCache = Buffer.from(key, 'hex');
  }
  return encKeyCache;
}

export function loadMemberWallet(signerId: SignerId): Wallet {
  const { secret } = JSON.parse(readFileSync(xrplMemberKeyFile(signerId), 'utf8')) as { secret: string };
  return Wallet.fromSeed(secret);
}

// ---------------------------------------------------------------------------
// shared client (lazy connect, reconnect, error-swallowing per FR-D2)
// ---------------------------------------------------------------------------

let client: Client | null = null;
export async function chainClient(): Promise<Client> {
  if (!client) {
    client = new Client(XRPL_WSS);
    client.on('error', () => {});
  }
  if (!client.isConnected()) await client.connect();
  return client;
}

export async function disconnectChain(): Promise<void> {
  if (client?.isConnected()) await client.disconnect();
}

// serialize submissions per publisher account (sequence numbers) via a simple queue
const queues = new Map<string, Promise<unknown>>();
function enqueue<T>(account: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(account) ?? Promise.resolve();
  const run = prev.then(task, task);
  queues.set(
    account,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// ---------------------------------------------------------------------------
// request encryption — a COMPACT binary blob so it fits one XRPL memo:
//   [32 requestHash][12 iv][16 gcm-tag][ ciphertext(gzip(json)) ]
// gzip + a single hex encoding keeps a full {request, debit} (incl. a 64-byte
// bank signature) well under the memo size limit.
// ---------------------------------------------------------------------------

export function packRequest(requestHash: string, obj: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'))), cipher.final()]);
  return Buffer.concat([Buffer.from(requestHash, 'hex'), iv, cipher.getAuthTag(), ct]).toString('hex');
}

export function unpackRequest<T = unknown>(hex: string): { requestHash: string; payload: T } {
  const buf = Buffer.from(hex, 'hex');
  const requestHash = buf.subarray(0, 32).toString('hex');
  const decipher = createDecipheriv('aes-256-gcm', encKey(), buf.subarray(32, 44));
  decipher.setAuthTag(buf.subarray(44, 60));
  const json = gunzipSync(Buffer.concat([decipher.update(buf.subarray(60)), decipher.final()])).toString('utf8');
  return { requestHash, payload: JSON.parse(json) as T };
}

// ---------------------------------------------------------------------------
// memo helpers
// ---------------------------------------------------------------------------

type MemoKind = 'noghost/request' | 'noghost/approval' | 'noghost/receipt';

function memo(kind: MemoKind, data: unknown) {
  return {
    Memo: {
      MemoType: convertStringToHex(kind),
      MemoFormat: convertStringToHex('application/json'),
      MemoData: convertStringToHex(JSON.stringify(data)),
    },
  };
}

/** A memo whose MemoData is already hex (compact binary payload). */
function rawMemo(kind: MemoKind, hexData: string) {
  return {
    Memo: { MemoType: convertStringToHex(kind), MemoFormat: convertStringToHex('application/octet-stream'), MemoData: hexData.toUpperCase() },
  };
}

/** Return the raw hex MemoData for a given memo kind (no JSON parse). */
function rawMemoData(tx: Record<string, unknown>, kind: MemoKind): string | null {
  const memos = (tx.Memos as Array<{ Memo?: { MemoType?: string; MemoData?: string } }> | undefined) ?? [];
  const want = convertStringToHex(kind).toUpperCase();
  for (const m of memos) {
    if (m.Memo?.MemoType?.toUpperCase() === want) return m.Memo.MemoData ?? null;
  }
  return null;
}

function parseMemos(tx: Record<string, unknown>): Array<{ kind: string; data: Record<string, unknown> }> {
  const memos = (tx.Memos as Array<{ Memo?: { MemoType?: string; MemoData?: string } }> | undefined) ?? [];
  const out: Array<{ kind: string; data: Record<string, unknown> }> = [];
  for (const m of memos) {
    try {
      const kind = m.Memo?.MemoType ? convertHexToString(m.Memo.MemoType) : '';
      const data = m.Memo?.MemoData ? JSON.parse(convertHexToString(m.Memo.MemoData)) : {};
      out.push({ kind, data });
    } catch {
      /* skip unparseable memo */
    }
  }
  return out;
}

async function submitTx(c: Client, wallet: Wallet, tx: SubmittableTransaction, what: string): Promise<{ hash: string; ledgerIndex?: number }> {
  return enqueue(wallet.address, async () => {
    const prepared = await c.autofill(tx);
    const signed = wallet.sign(prepared);
    const res = await c.submitAndWait(signed.tx_blob);
    const meta = res.result.meta;
    const code = typeof meta === 'object' && meta && 'TransactionResult' in meta ? (meta as { TransactionResult: string }).TransactionResult : '?';
    if (code !== 'tesSUCCESS') throw new Error(`${what}: ${code}`);
    return { hash: res.result.hash, ledgerIndex: (res.result as { ledger_index?: number }).ledger_index };
  });
}

// ---------------------------------------------------------------------------
// (1) publish request — coordinator's publisher wallet → authority
// ---------------------------------------------------------------------------

export interface OnChainRequest {
  requestHash: string;
  txHash: string;
  ledgerIndex?: number;
}

export async function publishRequest(publisher: Wallet, requestHash: string, plaintext: unknown): Promise<OnChainRequest> {
  const c = await chainClient();
  const auth = loadManifest().authority;
  const packed = packRequest(requestHash, plaintext);
  const { hash, ledgerIndex } = await submitTx(
    c,
    publisher,
    { TransactionType: 'Payment', Account: publisher.address, Destination: auth, Amount: '1', Memos: [rawMemo('noghost/request', packed)] },
    'publishRequest',
  );
  return { requestHash, txHash: hash, ledgerIndex };
}

/**
 * Read a published request BACK from the chain by its tx hash and decrypt it.
 * Ciphertext integrity is guaranteed by AES-GCM (a bad key/tamper throws on
 * decrypt); `requestHash` is the public identifier the caller binds to the
 * decrypted request (hashValue(payload.request)) before trusting it.
 */
export async function readRequestTx<T = unknown>(txHash: string): Promise<{ requestHash: string; payload: T } | null> {
  const c = await chainClient();
  const res = await c.request({ command: 'tx', transaction: txHash });
  const txjson = (res.result as { tx_json?: Record<string, unknown> }).tx_json ?? (res.result as unknown as Record<string, unknown>);
  const data = rawMemoData(txjson, 'noghost/request');
  if (!data) return null;
  return unpackRequest<T>(data);
}

// ---------------------------------------------------------------------------
// (2) member approval — member wallet → authority
// ---------------------------------------------------------------------------

export type Verdict = 'APPROVE' | 'REJECT';

export async function postApproval(member: Wallet, signerId: SignerId, requestHash: string, verdict: Verdict, reason?: string): Promise<{ txHash: string }> {
  const c = await chainClient();
  const auth = loadManifest().authority;
  const { hash } = await submitTx(
    c,
    member,
    { TransactionType: 'Payment', Account: member.address, Destination: auth, Amount: '1', Memos: [memo('noghost/approval', { v: 1, requestHash, signerId, verdict, ...(reason ? { reason } : {}) })] },
    'postApproval',
  );
  return { txHash: hash };
}

export interface ApprovalRecord {
  signerId: SignerId;
  verdict: Verdict;
  reason?: string;
  txHash: string;
  fromAddress: string;
}

/** Scan the authority account for all approvals matching a requestHash. */
export async function readApprovals(requestHash: string): Promise<ApprovalRecord[]> {
  const c = await chainClient();
  const auth = loadManifest().authority;
  const members = loadManifest().members;
  const addrToId = new Map(Object.entries(members).map(([id, addr]) => [addr, id as SignerId]));
  const res = await c.request({ command: 'account_tx', account: auth, limit: 200, ledger_index_min: -1, ledger_index_max: -1 });
  const out = new Map<SignerId, ApprovalRecord>(); // one (latest) per member
  for (const entry of res.result.transactions) {
    const tx = (entry.tx_json ?? (entry as { tx?: Record<string, unknown> }).tx) as Record<string, unknown> | undefined;
    if (!tx) continue;
    const from = String(tx.Account ?? '');
    const signerId = addrToId.get(from);
    if (!signerId) continue;
    for (const m of parseMemos(tx)) {
      if (m.kind === 'noghost/approval' && m.data.requestHash === requestHash && !out.has(signerId)) {
        out.set(signerId, {
          signerId,
          verdict: (m.data.verdict as Verdict) ?? 'REJECT',
          reason: m.data.reason ? String(m.data.reason) : undefined,
          txHash: String((entry as { hash?: string }).hash ?? tx.hash ?? ''),
          fromAddress: from,
        });
      }
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// (3) multisigned receipt — 2-of-3 members co-sign a tx on the authority account
// ---------------------------------------------------------------------------

export interface ReceiptFields {
  requestHash: string;
  debitRefHash: string;
  tokenHash: string;
  signerSet: SignerId[];
  ts: string;
}

/** Coordinator: autofill the receipt once so every signer signs an identical tx. */
export async function prepareReceipt(fields: ReceiptFields): Promise<SubmittableTransaction> {
  const c = await chainClient();
  const auth = loadManifest().authority;
  const quorum = loadManifest().quorum;
  const tx: SubmittableTransaction = {
    TransactionType: 'AccountSet',
    Account: auth,
    Memos: [memo('noghost/receipt', { v: 1, ...fields })],
  };
  const prepared = await c.autofill(tx, quorum);
  (prepared as { SigningPubKey?: string }).SigningPubKey = '';
  return prepared;
}

/** Member: produce a multisign fragment (signature) over the prepared receipt tx. */
export function signReceiptFragment(member: Wallet, prepared: SubmittableTransaction): string {
  return member.sign(prepared, true).tx_blob;
}

/** Coordinator: combine fragments and submit the multisigned receipt. */
export async function submitReceipt(fragments: string[]): Promise<{ txHash: string; ledgerIndex?: number; explorerUrl: string }> {
  const c = await chainClient();
  const combined = multisign(fragments);
  const res = await c.submitAndWait(combined);
  const meta = res.result.meta;
  const code = typeof meta === 'object' && meta && 'TransactionResult' in meta ? (meta as { TransactionResult: string }).TransactionResult : '?';
  if (code !== 'tesSUCCESS') throw new Error(`submitReceipt: ${code}`);
  return { txHash: res.result.hash, ledgerIndex: (res.result as { ledger_index?: number }).ledger_index, explorerUrl: XRPL_EXPLORER_TX(res.result.hash) };
}
