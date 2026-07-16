/**
 * Coordinator service (CONTRACTS.md §3) — port 4000.
 * Express HTTP API under /api + `ws` WebSocketServer on the same HTTP server
 * at path /ws. On connect clients receive {type:'hello', state: Snapshot};
 * every state change is broadcast as a WsEvent.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { PORTS, SIGNERS } from '../common/config.js';
import type { BankMode, SignerId } from '../common/types.js';
import { runScenario, SCENARIO_KINDS, type ScenarioKind } from './demo.js';
import { pollAllHealth, setBankMode, setSignerOnline } from './health.js';
import { runPipeline } from './pipeline.js';
import * as store from './store.js';

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// FR-14 — anti-spam / DoS guard: a per-merchant sliding-window rate limit on
// request submission (an availability control, not validator payment). Generous
// enough never to hamper the live demo; strict enough to stop a flood that would
// drive bank round-trips and XRPL writes against the shared wallet.
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_PER_WINDOW = 20;
const merchantHits = new Map<string, number[]>();

function rateLimitOk(merchantId: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const hits = (merchantHits.get(merchantId) ?? []).filter((t) => t > cutoff);
  if (hits.length >= RATE_MAX_PER_WINDOW) {
    merchantHits.set(merchantId, hits);
    return false;
  }
  hits.push(now);
  merchantHits.set(merchantId, hits);
  return true;
}

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------

app.post('/api/requests', (req, res) => {
  const body = req.body ?? {};
  const { meterId, amountKwh, merchantId } = body;
  if (typeof meterId !== 'string' || meterId.trim() === '') {
    return res.status(400).json({ error: 'meterId must be a non-empty string' });
  }
  if (typeof merchantId !== 'string' || merchantId.trim() === '') {
    return res.status(400).json({ error: 'merchantId must be a non-empty string' });
  }
  if (typeof amountKwh !== 'number' || !Number.isFinite(amountKwh) || amountKwh <= 0) {
    return res.status(400).json({ error: 'amountKwh must be a finite number > 0' });
  }
  if (body.requestId !== undefined && (typeof body.requestId !== 'string' || body.requestId.trim() === '')) {
    return res.status(400).json({ error: 'requestId, when given, must be a non-empty string' });
  }

  const requestId: string = body.requestId?.trim() || `REQ-${randomUUID()}`;
  // FR-16 — idempotency: an existing requestId never re-runs the pipeline
  // (checked before the rate limit so a client's safe retry is never throttled)
  if (store.getRequest(requestId)) {
    return res.status(200).json({ requestId, existing: true });
  }

  // FR-14 — anti-spam: throttle new requests per merchant
  if (!rateLimitOk(merchantId.trim())) {
    return res.status(429).json({
      error: 'RATE_LIMITED',
      detail: `merchant ${merchantId} exceeded ${RATE_MAX_PER_WINDOW} requests / ${RATE_WINDOW_MS / 1000}s (FR-14 anti-spam)`,
    });
  }

  const record = store.createRecord({
    requestId,
    meterId: meterId.trim(),
    amountKwh,
    merchantId: merchantId.trim(),
    timestamp: new Date().toISOString(),
  });
  void runPipeline(record); // async — FR-17 guarantees it always terminates the record
  return res.status(202).json({ requestId });
});

app.get('/api/requests', (_req, res) => res.json(store.listRequests()));

app.get('/api/requests/:id', (req, res) => {
  const record = store.getRequest(req.params.id);
  if (!record) return res.status(404).json({ error: 'unknown requestId' });
  return res.json(record);
});

// ---------------------------------------------------------------------------
// state / observability
// ---------------------------------------------------------------------------

app.get('/api/state', (_req, res) => res.json(store.buildSnapshot()));
app.get('/api/reconciliation', (_req, res) => res.json(store.computeReconciliation()));
app.get('/api/consortium', (_req, res) => res.json(store.getConsortiumStatus()));
app.get('/api/audit', (_req, res) => res.json(store.listAudit()));
app.get('/api/merchants', (_req, res) => res.json(store.listMerchants()));

// ---------------------------------------------------------------------------
// governance (FR-13 / FR-19)
// ---------------------------------------------------------------------------

app.post('/api/merchants/:id/revoke', (req, res) => {
  const m = store.setMerchantRevoked(req.params.id, true, 'operator');
  if (!m) return res.status(404).json({ error: 'unknown merchant' });
  return res.json(m);
});

app.post('/api/merchants/:id/reinstate', (req, res) => {
  const m = store.setMerchantRevoked(req.params.id, false, 'operator');
  if (!m) return res.status(404).json({ error: 'unknown merchant' });
  return res.json(m);
});

function isSignerId(id: string): id is SignerId {
  return SIGNERS.some((s) => s.signerId === id);
}

app.post('/api/governance/members/:signerId/revoke', (req, res) => {
  const id = req.params.signerId;
  if (!isSignerId(id)) return res.status(404).json({ error: 'unknown signer' });
  return res.json(store.setMemberStatus(id, 'REVOKED', 'operator'));
});

app.post('/api/governance/members/:signerId/reinstate', (req, res) => {
  const id = req.params.signerId;
  if (!isSignerId(id)) return res.status(404).json({ error: 'unknown signer' });
  return res.json(store.setMemberStatus(id, 'ACTIVE', 'operator'));
});

// ---------------------------------------------------------------------------
// demo controls (§6.3)
// ---------------------------------------------------------------------------

const BANK_MODES: BankMode[] = ['CONFIRM', 'DECLINE', 'OMIT_SIGNATURE', 'TIMEOUT'];

app.post('/api/demo/bank-mode', async (req, res) => {
  const mode = req.body?.mode as BankMode;
  if (!BANK_MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${BANK_MODES.join(', ')}` });
  const r = await setBankMode(mode); // emits bank.status on change
  if (!r) return res.status(502).json({ error: 'bank unreachable' });
  return res.json({ mode: r.body?.mode ?? mode });
});

app.post('/api/demo/signers/:signerId', async (req, res) => {
  const id = req.params.signerId;
  if (!isSignerId(id)) return res.status(404).json({ error: 'unknown signer' });
  const online = req.body?.online;
  if (typeof online !== 'boolean') return res.status(400).json({ error: 'online must be a boolean' });
  const r = await setSignerOnline(id, online); // emits consortium.status on change
  if (!r) return res.status(502).json({ error: 'signer unreachable' });
  return res.json({ signerId: id, online });
});

app.post('/api/demo/scenario', async (req, res) => {
  const kind = req.body?.kind as ScenarioKind;
  if (!SCENARIO_KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of ${SCENARIO_KINDS.join(', ')}` });
  }
  const result = await runScenario(kind);
  return res.status(202).json(result);
});

// ---------------------------------------------------------------------------
// HTTP server + WS hub
// ---------------------------------------------------------------------------

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  socket.on('error', () => {});
  socket.send(JSON.stringify({ type: 'hello', state: store.buildSnapshot() }));
});

// every store mutation broadcasts a WsEvent — fan it out to all live sockets
store.subscribe((ev) => {
  const data = JSON.stringify(ev);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
});

server.listen(PORTS.coordinator, () => {
  store.log('listening', { port: PORTS.coordinator, ws: '/ws' });
});

// health polling: bank + signers every 3s; statuses broadcast only on change
void pollAllHealth();
setInterval(() => {
  void pollAllHealth();
}, 3000);

// demo hardening (FR-D2): the coordinator itself must never crash
process.on('unhandledRejection', (err) => store.log('unhandledRejection', { error: String(err) }));
process.on('uncaughtException', (err) => store.log('uncaughtException', { error: String(err) }));
