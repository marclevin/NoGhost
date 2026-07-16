/**
 * Mock bank service — Wall 1 (CONTRACTS.md §1). Port 4100.
 *
 * Confirms (and Ed25519-signs) debit requests, or — in demo modes — declines,
 * omits the signature (forged attestation), or times out. Keeps an in-memory
 * debit log and reversal log. Idempotent on requestId.
 */
import express from 'express';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { KEYS_DIR, PORTS } from '../common/config.js';
import { bytesToHex } from '../common/canonical.js';
import type { BankMode, DebitConfirmation, DebitRequest } from '../common/types.js';
import { signDebitPayload, debitSignedPayload, ZERO_SIGNATURE } from './sign.js';

const log = (evt: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), svc: 'bank', evt, ...extra }));

// --- keys (created by the key ceremony; PRIVATE signing key never leaves) ---
const { secretKey } = JSON.parse(readFileSync(resolve(KEYS_DIR, 'bank.json'), 'utf8')) as { secretKey: string };
const { publicKey } = JSON.parse(readFileSync(resolve(KEYS_DIR, 'bank.pub.json'), 'utf8')) as { publicKey: string };

// --- state ------------------------------------------------------------------
const MODES: readonly BankMode[] = ['CONFIRM', 'DECLINE', 'OMIT_SIGNATURE', 'TIMEOUT'];
let mode: BankMode = 'CONFIRM';

interface DebitLogEntry {
  debit: DebitConfirmation;
  reversed: boolean;
  outcome: 'CONFIRMED' | 'OMIT_SIGNATURE';
}
const debitLog: DebitLogEntry[] = [];
const byRequestId = new Map<string, DebitLogEntry>();
const byDebitRef = new Map<string, DebitLogEntry>();
const reversalLog: Array<{ debitRef: string; at: string }> = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- app --------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ up: true, mode });
});

app.get('/api/public-key', (_req, res) => {
  res.json({ publicKey });
});

app.get('/api/admin/mode', (_req, res) => {
  res.json({ mode });
});

app.post('/api/admin/mode', (req, res) => {
  const next = (req.body as { mode?: unknown } | undefined)?.mode;
  if (typeof next !== 'string' || !MODES.includes(next as BankMode)) {
    res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });
    return;
  }
  mode = next as BankMode;
  log('mode.changed', { mode });
  res.json({ mode });
});

app.post('/api/debits', async (req, res) => {
  const body = req.body as Partial<DebitRequest> | undefined;
  if (
    !body ||
    typeof body.requestId !== 'string' ||
    body.requestId.length === 0 ||
    typeof body.merchantId !== 'string' ||
    typeof body.meterId !== 'string' ||
    body.meterId.length === 0 ||
    typeof body.amountKwh !== 'number' ||
    !Number.isFinite(body.amountKwh) ||
    typeof body.amount !== 'number' ||
    !Number.isFinite(body.amount) ||
    typeof body.currency !== 'string'
  ) {
    res.status(400).json({ error: 'invalid DebitRequest' });
    return;
  }

  // FR idempotency: a prior confirmation for this requestId is always returned
  // verbatim, regardless of the current demo mode.
  const prior = byRequestId.get(body.requestId);
  if (prior) {
    log('debit.idempotent_replay', { requestId: body.requestId, debitRef: prior.debit.debitRef });
    res.json(prior.debit);
    return;
  }

  switch (mode) {
    case 'DECLINE': {
      log('debit.declined', { requestId: body.requestId, merchantId: body.merchantId });
      res.status(402).json({ declined: true, reason: 'Debit declined — no funds movement authorised.' });
      return;
    }
    case 'TIMEOUT': {
      log('debit.timeout_start', { requestId: body.requestId });
      await sleep(8000);
      res.status(504).json({ timeout: true });
      return;
    }
    case 'CONFIRM':
    case 'OMIT_SIGNATURE': {
      const payload = debitSignedPayload({
        debitRef: 'DBT-' + bytesToHex(randomBytes(6)), // 'DBT-' + 12 hex chars
        requestId: body.requestId,
        meterId: body.meterId,
        amountKwh: body.amountKwh,
        amount: body.amount,
        currency: body.currency,
        confirmedAt: new Date().toISOString(),
      });
      const debit: DebitConfirmation = {
        ...payload,
        bankSignature: mode === 'CONFIRM' ? signDebitPayload(payload, secretKey) : ZERO_SIGNATURE,
      };
      const entry: DebitLogEntry = {
        debit,
        reversed: false,
        outcome: mode === 'CONFIRM' ? 'CONFIRMED' : 'OMIT_SIGNATURE',
      };
      debitLog.push(entry);
      byRequestId.set(debit.requestId, entry);
      byDebitRef.set(debit.debitRef, entry);
      log('debit.confirmed', {
        requestId: debit.requestId,
        debitRef: debit.debitRef,
        amount: debit.amount,
        outcome: entry.outcome,
      });
      res.json(debit);
      return;
    }
  }
});

/** FR-21: reverse a confirmed debit (customer refunded). */
app.post('/api/debits/:debitRef/reverse', (req, res) => {
  const debitRef = req.params.debitRef;
  const entry = byDebitRef.get(debitRef);
  if (!entry) {
    res.status(404).json({ error: 'unknown debitRef' });
    return;
  }
  if (!entry.reversed) {
    entry.reversed = true;
    reversalLog.push({ debitRef, at: new Date().toISOString() });
    log('debit.reversed', { debitRef, requestId: entry.debit.requestId });
  }
  res.json({ reversed: true, debitRef });
});

/** Observability: full debit log. */
app.get('/api/debits', (_req, res) => {
  res.json(debitLog.map((e) => ({ debit: e.debit, reversed: e.reversed, outcome: e.outcome })));
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log('http.error', { err: String(err?.message ?? err) });
  if (!res.headersSent) res.status(err?.name === 'SyntaxError' ? 400 : 500).json({ error: 'internal error' });
});

// FR-D2: never crash the demo on a stray async failure.
process.on('uncaughtException', (e) => log('uncaught_exception', { err: String(e) }));
process.on('unhandledRejection', (e) => log('unhandled_rejection', { err: String(e) }));

app.listen(PORTS.bank, () => log('listening', { port: PORTS.bank, mode, publicKey }));
