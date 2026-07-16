/**
 * XRPL testnet ledger writer (§3.2) — the immutable witness.
 *
 * - Connects lazily once, reuses the client, reconnects on drop.
 * - Serializes submissions through a promise queue (account sequence numbers).
 * - Writes an AccountSet self-transaction carrying one JSON memo of hashes
 *   only (POPIA-safe, NFR-3) and requires tesSUCCESS.
 *
 * The wallet secret comes from the root .env via config.ts and is NEVER logged.
 */
import { Client, Wallet, convertStringToHex } from 'xrpl';
import { XRPL_WSS, XRP_WALLET_SECRET, XRPL_EXPLORER_TX } from '../common/config.js';
import type { LedgerRecord, SignerId } from '../common/types.js';

export interface AuthorisationInput {
  requestHash: string;
  debitRefHash: string;
  tokenHash: string;
  signerSet: SignerId[];
}

let client: Client | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function ensureClient(): Promise<Client> {
  if (!XRP_WALLET_SECRET) throw new Error('XRP_WALLET_SECRET is not configured (root .env)');
  if (!client) {
    client = new Client(XRPL_WSS);
    // swallow transport-level error events so they never crash the process (FR-D2)
    client.on('error', () => {});
  }
  if (!client.isConnected()) await client.connect();
  return client;
}

/** Submit one authorisation memo. Calls are serialized — one in-flight tx at a time. */
export function submitAuthorisation(input: AuthorisationInput): Promise<LedgerRecord> {
  const run = queue.then(() => doSubmit(input));
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function doSubmit(input: AuthorisationInput): Promise<LedgerRecord> {
  const c = await ensureClient();
  const wallet = Wallet.fromSeed(XRP_WALLET_SECRET);
  const timestamp = new Date().toISOString();
  const memoData = JSON.stringify({
    v: 1,
    requestHash: input.requestHash,
    debitRefHash: input.debitRefHash,
    tokenHash: input.tokenHash,
    signerSet: input.signerSet,
    ts: timestamp,
  });

  const prepared = await c.autofill({
    TransactionType: 'AccountSet' as const,
    Account: wallet.address,
    Memos: [
      {
        Memo: {
          MemoType: convertStringToHex('twowalls/authorisation'),
          MemoFormat: convertStringToHex('application/json'),
          MemoData: convertStringToHex(memoData),
        },
      },
    ],
  });
  const signed = wallet.sign(prepared);
  const result = await c.submitAndWait(signed.tx_blob);

  const meta = result.result.meta;
  const code =
    typeof meta === 'object' && meta !== null && 'TransactionResult' in meta
      ? (meta as { TransactionResult: string }).TransactionResult
      : 'unknown';
  if (code !== 'tesSUCCESS') throw new Error(`XRPL transaction result ${code} (expected tesSUCCESS)`);

  const ledgerIndex = (result.result as { ledger_index?: number }).ledger_index;
  return {
    requestHash: input.requestHash,
    debitRefHash: input.debitRefHash,
    tokenHash: input.tokenHash,
    signerSet: input.signerSet,
    timestamp,
    txHash: result.result.hash,
    ...(ledgerIndex !== undefined ? { ledgerIndex } : {}),
    explorerUrl: XRPL_EXPLORER_TX(result.result.hash),
  };
}

/** Graceful shutdown helper (not required by the contract, handy for scripts). */
export async function disconnectXrpl(): Promise<void> {
  if (client?.isConnected()) await client.disconnect();
}
