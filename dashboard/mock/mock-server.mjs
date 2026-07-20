/**
 * Tiny HTTP-only mock of the coordinator (port 4000) for developing the dashboard
 * before the real coordinator exists. No WebSocket — the dashboard's polling
 * fallback (GET /api/state every 2s) picks up all changes.
 *
 * Run: node dashboard/mock/mock-server.mjs
 */
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

const PORT = 4000;
const hex = (n) => randomBytes(n).toString('hex');
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const priceZar = (kwh) => Math.round(kwh * 2.5 * 100) / 100;

const SIGNERS = [
  { signerId: 'utility', name: 'National Utility', org: 'Utility', identifier: 1 },
  { signerId: 'city-a', name: 'City A Metro', org: 'Municipality A', identifier: 2 },
  { signerId: 'city-b', name: 'City B Metro', org: 'Municipality B', identifier: 3 },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  requests: [],
  bank: { up: true, mode: 'CONFIRM', confirmRatePct: 95, lastConfirmationAt: iso(42_000) },
  consortium: {
    threshold: { t: 2, n: 3 },
    groupPublicKey: hex(32),
    signers: SIGNERS.map((s) => ({
      ...s,
      online: true,
      sharePresent: true,
      refuse: false,
      lastPartialAt: iso(60_000 + s.identifier * 30_000),
      revoked: false,
    })),
    quorumReachable: true,
  },
  reconciliation: { tokensIssued: 0, confirmedDebits: 0, onChainRecords: 0, delta: 0, series: [] },
  alerts: [],
  members: SIGNERS.map((s) => ({
    ...s,
    status: 'ACTIVE',
    bond: {
      posture: 'BONDED',
      amountZar: 5_000_000,
      note: 'Conceptual bond posture (PoC): a production consortium stakes an economic bond slashable on provable misbehaviour. Displayed, not enforced.',
    },
  })),
  merchants: [
    { merchantId: 'MER-001', name: "Thabo's Spaza", vetted: true, revoked: false },
    { merchantId: 'MER-002', name: 'QuickPay Kiosk', vetted: true, revoked: false },
    { merchantId: 'MER-003', name: 'PayZone CityMall', vetted: true, revoked: false },
  ],
  governanceLog: [
    {
      id: randomUUID(),
      at: iso(3_600_000),
      action: 'MEMBER_LISTED',
      subject: 'city-b',
      actor: 'operator',
      detail: 'City B Metro admitted to consortium',
    },
  ],
  meters: ['MTR-1001', 'MTR-1002', 'MTR-1003', 'MTR-1004', 'MTR-1005', 'MTR-1006'].map((meterId) => ({
    meterId,
    balanceKwh: 0,
    lastDispenseAt: null,
    dispenses: 0,
  })),
  demo: { activeScenario: null },
};

function refreshQuorum() {
  const avail = state.consortium.signers.filter((s) => s.online && !s.revoked).length;
  state.consortium.quorumReachable = avail >= state.consortium.threshold.t;
}

function pushAlert(severity, title, message, attribution, wall, requestId) {
  state.alerts.unshift({ id: randomUUID(), severity, wall, requestId, title, message, attribution, at: iso() });
  state.alerts = state.alerts.slice(0, 100);
}

function govLog(action, subject, detail) {
  state.governanceLog.unshift({ id: randomUUID(), at: iso(), action, subject, actor: 'operator', detail });
}

function bumpRecon(t) {
  const r = state.reconciliation;
  r.tokensIssued += 1;
  r.confirmedDebits += 1;
  r.onChainRecords += 1;
  r.delta = Math.max(Math.abs(r.tokensIssued - r.confirmedDebits), Math.abs(r.tokensIssued - r.onChainRecords));
  r.series.push({ t, tokens: r.tokensIssued, debits: r.confirmedDebits, records: r.onChainRecords });
  r.series = r.series.slice(-200);
}

// ---------------------------------------------------------------------------
// Fabricated pipeline records (all states represented)
// ---------------------------------------------------------------------------

let meterIdx = 0;
let merchantIdx = 0;
const nextMeter = () => state.meters[meterIdx++ % state.meters.length].meterId;
const nextMerchant = () => state.merchants[merchantIdx++ % state.merchants.length].merchantId;

function makeRequest(kwh, msAgo = 0) {
  return {
    requestId: randomUUID(),
    meterId: nextMeter(),
    amountKwh: kwh,
    merchantId: nextMerchant(),
    timestamp: iso(msAgo),
  };
}

function makeDebit(req, msAgo = 0) {
  return {
    debitRef: 'DBT-' + hex(6).toUpperCase(),
    requestId: req.requestId,
    amount: priceZar(req.amountKwh),
    currency: 'ZAR',
    confirmedAt: iso(msAgo),
    bankSignature: hex(64),
  };
}

function makeDelivered(kwh, msAgo) {
  const req = makeRequest(kwh, msAgo);
  const debit = makeDebit(req, msAgo - 800);
  const nonce = hex(16);
  const signerSet = ['utility', 'city-a'];
  const txHash = hex(32).toUpperCase();
  const ts = iso(msAgo - 4000);
  const rec = {
    request: req,
    status: 'DELIVERED',
    history: [
      { status: 'PENDING', at: iso(msAgo) },
      { status: 'DEBIT_CONFIRMED', at: iso(msAgo - 800), note: `debit ${debit.debitRef} confirmed` },
      { status: 'SIGNED', at: iso(msAgo - 2200), note: `quorum ${signerSet.join('+')}` },
      { status: 'RECORDED', at: ts, note: `tx ${txHash.slice(0, 10)}…` },
      { status: 'DELIVERED', at: iso(msAgo - 4600) },
    ],
    debit,
    signerSet,
    token: { meterId: req.meterId, amountKwh: req.amountKwh, nonce, signature: hex(64) },
    ledger: {
      requestHash: hex(32),
      debitRefHash: hex(32),
      tokenHash: hex(32),
      signerSet,
      timestamp: ts,
      txHash,
      ledgerIndex: 4_812_000 + Math.floor(Math.random() * 9000),
      explorerUrl: `https://testnet.xrpl.org/transactions/${txHash}`,
    },
    meterDelivery: { verified: true, dispensedKwh: req.amountKwh, at: iso(msAgo - 4600) },
  };
  const meter = state.meters.find((m) => m.meterId === req.meterId);
  meter.balanceKwh += req.amountKwh;
  meter.lastDispenseAt = rec.meterDelivery.at;
  meter.dispenses += 1;
  bumpRecon(rec.meterDelivery.at);
  return rec;
}

function seed() {
  const recs = [];
  recs.push(makeDelivered(50, 15 * 60_000));
  recs.push(makeDelivered(120, 12 * 60_000));

  // rejected at wall 1 (ghost-vend)
  {
    const req = makeRequest(75, 9 * 60_000);
    recs.push({
      request: req,
      status: 'REJECTED',
      history: [
        { status: 'PENDING', at: iso(9 * 60_000) },
        { status: 'REJECTED', at: iso(9 * 60_000 - 900), note: 'bank declined' },
      ],
      rejection: {
        wall: 'WALL_1_BANK',
        reason: 'Debit declined: no funds movement authorised.',
        at: iso(9 * 60_000 - 900),
        attribution: req.merchantId,
      },
    });
    pushAlert(
      'critical',
      'Ghost-vend attempt blocked at Wall 1',
      `Request for ${req.amountKwh} kWh on ${req.meterId} had no confirmed debit; token never created.`,
      req.merchantId,
      'WALL_1_BANK',
      req.requestId,
    );
  }

  // rejected at wall 2 (collusion short)
  {
    const req = makeRequest(30, 6 * 60_000);
    recs.push({
      request: req,
      status: 'REJECTED',
      history: [
        { status: 'PENDING', at: iso(6 * 60_000) },
        { status: 'DEBIT_CONFIRMED', at: iso(6 * 60_000 - 700) },
        { status: 'REJECTED', at: iso(6 * 60_000 - 1500), note: 'below threshold' },
      ],
      debit: makeDebit(req, 6 * 60_000 - 700),
      debitReversed: true,
      rejection: {
        wall: 'WALL_2_CONSORTIUM',
        reason: 'BELOW_THRESHOLD (1 of 3 signers available, need 2)',
        at: iso(6 * 60_000 - 1500),
        attribution: 'signers offline: city-a, city-b',
      },
    });
    pushAlert(
      'warning',
      'Quorum unreachable: generation blocked at Wall 2',
      'Only 1 of 3 signers available (need 2). Debit reversed, customer refunded.',
      'city-a, city-b',
      'WALL_2_CONSORTIUM',
      req.requestId,
    );
  }

  // abandoned at ledger stage (FR-21)
  {
    const req = makeRequest(25, 4 * 60_000);
    recs.push({
      request: req,
      status: 'REJECTED_ABANDONED',
      history: [
        { status: 'PENDING', at: iso(4 * 60_000) },
        { status: 'DEBIT_CONFIRMED', at: iso(4 * 60_000 - 600) },
        { status: 'SIGNED', at: iso(4 * 60_000 - 1900) },
        { status: 'REJECTED_ABANDONED', at: iso(4 * 60_000 - 4000), note: 'ledger submit failed; debit reversed' },
      ],
      debit: makeDebit(req, 4 * 60_000 - 600),
      debitReversed: true,
      signerSet: ['utility', 'city-b'],
      rejection: {
        wall: 'LEDGER',
        reason: 'XRPL submission failed (network): request abandoned',
        at: iso(4 * 60_000 - 4000),
        attribution: 'xrpl-testnet',
      },
    });
    pushAlert('info', 'Request abandoned: debit reversed', 'Ledger write failed; the confirmed debit was reversed and the customer refunded (FR-21).', 'xrpl-testnet', 'LEDGER', req.requestId);
  }

  recs.push(makeDelivered(80, 2 * 60_000));

  // one in-flight request (stuck mid-ceremony, for stepper pulse)
  {
    const req = makeRequest(60, 20_000);
    recs.push({
      request: req,
      status: 'DEBIT_CONFIRMED',
      history: [
        { status: 'PENDING', at: iso(20_000) },
        { status: 'DEBIT_CONFIRMED', at: iso(19_000) },
      ],
      debit: makeDebit(req, 19_000),
    });
  }

  recs.sort((a, b) => (a.request.timestamp < b.request.timestamp ? 1 : -1));
  state.requests = recs;
  state.bank.lastConfirmationAt = iso(2 * 60_000);
}
seed();

// ---------------------------------------------------------------------------
// Scenario simulation (advances via timers; polling picks it up)
// ---------------------------------------------------------------------------

function transition(rec, status, note) {
  rec.status = status;
  rec.history.push({ status, at: iso(), note });
}

// The operator's own bank/signer settings, captured before a scenario overrides
// them so they can be handed back afterwards instead of reset to defaults.
// Captured by the first scenario in a chain, restored by the last to finish.
let baseline = null;
let inFlight = 0;

function captureControls() {
  return {
    bankMode: state.bank.mode,
    signers: state.consortium.signers.map((s) => ({ signerId: s.signerId, online: s.online })),
  };
}

/** Precondition helper: scenarios need a known-good starting point. */
function setControls(bankMode, allSignersOnline) {
  state.bank.mode = bankMode;
  if (allSignersOnline) for (const s of state.consortium.signers) s.online = true;
  refreshQuorum();
}

function finishScenario() {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight !== 0 || !baseline) return;
  state.bank.mode = baseline.bankMode;
  for (const want of baseline.signers) {
    const live = state.consortium.signers.find((s) => s.signerId === want.signerId);
    if (live) live.online = want.online;
  }
  refreshQuorum();
  baseline = null;
  state.demo.activeScenario = null;
}

function runLegit(rec) {
  setControls('CONFIRM', true);
  setTimeout(() => {
    rec.debit = makeDebit(rec.request);
    state.bank.lastConfirmationAt = iso();
    transition(rec, 'DEBIT_CONFIRMED', `debit ${rec.debit.debitRef} confirmed`);
  }, 900);
  setTimeout(() => {
    const online = state.consortium.signers.filter((s) => s.online && !s.revoked).slice(0, 2);
    rec.signerSet = online.map((s) => s.signerId);
    for (const s of online) {
      const live = state.consortium.signers.find((x) => x.signerId === s.signerId);
      live.lastPartialAt = iso();
    }
    transition(rec, 'SIGNED', `quorum ${rec.signerSet.join('+')}`);
  }, 2100);
  setTimeout(() => {
    const txHash = hex(32).toUpperCase();
    rec.ledger = {
      requestHash: hex(32),
      debitRefHash: hex(32),
      tokenHash: hex(32),
      signerSet: rec.signerSet,
      timestamp: iso(),
      txHash,
      ledgerIndex: 4_820_000 + Math.floor(Math.random() * 9000),
      explorerUrl: `https://testnet.xrpl.org/transactions/${txHash}`,
    };
    transition(rec, 'RECORDED', `tx ${txHash.slice(0, 10)}…`);
  }, 3600);
  setTimeout(() => {
    rec.token = { meterId: rec.request.meterId, amountKwh: rec.request.amountKwh, nonce: hex(16), signature: hex(64) };
    rec.meterDelivery = { verified: true, dispensedKwh: rec.request.amountKwh, at: iso() };
    transition(rec, 'DELIVERED');
    const meter = state.meters.find((m) => m.meterId === rec.request.meterId);
    if (meter) {
      meter.balanceKwh += rec.request.amountKwh;
      meter.lastDispenseAt = iso();
      meter.dispenses += 1;
    }
    bumpRecon(iso());
    finishScenario();
  }, 4800);
}

function runGhost(rec) {
  setControls('DECLINE', false);
  setTimeout(() => {
    rec.rejection = {
      wall: 'WALL_1_BANK',
      reason: 'Debit declined: no funds movement authorised.',
      at: iso(),
      attribution: rec.request.merchantId,
    };
    transition(rec, 'REJECTED', 'bank declined');
    state.bank.confirmRatePct = Math.max(0, state.bank.confirmRatePct - 5);
    pushAlert(
      'critical',
      'Ghost-vend attempt blocked at Wall 1',
      `Request for ${rec.request.amountKwh} kWh on ${rec.request.meterId} had no confirmed debit; the token was never born.`,
      rec.request.merchantId,
      'WALL_1_BANK',
      rec.request.requestId,
    );
  }, 1200);
  setTimeout(finishScenario, 2400);
}

function runCollusion(rec) {
  setControls('CONFIRM', true);
  for (const s of state.consortium.signers) if (s.signerId !== 'utility') s.online = false;
  refreshQuorum();
  setTimeout(() => {
    rec.rejection = {
      wall: 'WALL_2_CONSORTIUM',
      reason: 'BELOW_THRESHOLD (1 of 3 signers available, need 2)',
      at: iso(),
      attribution: 'signers offline: city-a, city-b',
    };
    transition(rec, 'REJECTED', 'below threshold; no round 1 attempted');
    pushAlert(
      'warning',
      'Collusion-short blocked at Wall 2',
      'Only 1 of 3 signers participated; below the 2-of-3 threshold. One insider holds a useless fragment.',
      'utility (alone)',
      'WALL_2_CONSORTIUM',
      rec.request.requestId,
    );
  }, 1400);
  setTimeout(finishScenario, 2800);
}

/** Bank answers 200 OK but the attestation does not verify against the pinned key. */
function runForgedAttestation(rec) {
  setControls('OMIT_SIGNATURE', true);
  setTimeout(() => {
    rec.rejection = {
      wall: 'WALL_1_BANK',
      reason: 'BANK_SIGNATURE_INVALID',
      at: iso(),
      attribution: rec.request.merchantId,
    };
    transition(rec, 'REJECTED', 'bank attestation failed FR-3 verification');
    pushAlert(
      'critical',
      'Ghost-vend attempt blocked at Wall 1',
      'The bank attestation failed independent signature verification (FR-3): forged or absent confirmation.',
      rec.request.merchantId,
      'WALL_1_BANK',
      rec.request.requestId,
    );
  }, 1300);
  setTimeout(finishScenario, 2600);
}

/** Policy gate (FR-19): stopped before any funds movement or signer contact. */
function runRevokedMerchant(rec) {
  setControls('CONFIRM', true);
  const m = state.merchants.find((x) => x.merchantId === rec.request.merchantId);
  if (m) {
    m.revoked = true;
    govLog('MERCHANT_REVOKED', m.merchantId, `${m.name} revoked for demo scenario`);
  }
  setTimeout(() => {
    rec.rejection = {
      wall: 'POLICY',
      reason: `MERCHANT_REVOKED (${m?.name ?? rec.request.merchantId})`,
      at: iso(),
      attribution: rec.request.merchantId,
    };
    transition(rec, 'REJECTED', 'merchant revoked at the policy gate');
    pushAlert(
      'warning',
      'Revoked merchant blocked',
      `Merchant ${m?.name ?? rec.request.merchantId} (${rec.request.merchantId}) is revoked; request rejected (FR-19).`,
      rec.request.merchantId,
      'POLICY',
      rec.request.requestId,
    );
  }, 900);
  setTimeout(() => {
    // Merchant revocation is scoped to this scenario, so it is always undone here
    // rather than deferred to the shared baseline.
    if (m) {
      m.revoked = false;
      govLog('MERCHANT_REINSTATED', m.merchantId, `${m.name} reinstated after demo scenario`);
    }
    finishScenario();
  }, 2200);
}

const SCENARIO_KWH = {
  legit: 50,
  ghost: 75,
  'collusion-short': 30,
  'forged-attestation': 60,
  'revoked-merchant': 25,
};

const SCENARIO_RUNNERS = {
  legit: runLegit,
  ghost: runGhost,
  'collusion-short': runCollusion,
  'forged-attestation': runForgedAttestation,
  'revoked-merchant': runRevokedMerchant,
};

const SCENARIO_KINDS = Object.keys(SCENARIO_RUNNERS);

function startScenario(kind) {
  const req = makeRequest(SCENARIO_KWH[kind] ?? 30);
  const rec = { request: req, status: 'PENDING', history: [{ status: 'PENDING', at: iso() }] };
  state.requests.unshift(rec);
  state.requests = state.requests.slice(0, 200);
  state.demo.activeScenario = kind;
  if (inFlight === 0) baseline = captureControls();
  inFlight += 1;
  SCENARIO_RUNNERS[kind](rec);
  return req.requestId;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function send(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  });
  res.end(json);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (req.method === 'GET') {
    if (path === '/api/state') return send(res, 200, state);
    if (path === '/api/reconciliation') return send(res, 200, state.reconciliation);
    if (path === '/api/consortium') return send(res, 200, state.consortium);
    if (path === '/api/requests') return send(res, 200, state.requests);
    if (path === '/api/merchants') return send(res, 200, state.merchants);
    if (path === '/api/audit')
      return send(res, 200, state.requests.filter((r) => r.ledger).map((r) => r.ledger));
    return send(res, 404, { error: 'not found' });
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* ignore */
    }

    if (path === '/api/demo/scenario') {
      const kind = body.kind;
      if (!SCENARIO_KINDS.includes(kind)) return send(res, 400, { error: 'bad kind' });
      const requestId = startScenario(kind);
      return send(res, 202, { requestId, kind });
    }

    if (path === '/api/demo/bank-mode') {
      if (!['CONFIRM', 'DECLINE', 'OMIT_SIGNATURE', 'TIMEOUT'].includes(body.mode))
        return send(res, 400, { error: 'bad mode' });
      state.bank.mode = body.mode;
      return send(res, 200, { mode: state.bank.mode });
    }

    let m = path.match(/^\/api\/demo\/signers\/([\w-]+)$/);
    if (m) {
      const s = state.consortium.signers.find((x) => x.signerId === m[1]);
      if (!s) return send(res, 404, { error: 'unknown signer' });
      s.online = Boolean(body.online);
      refreshQuorum();
      return send(res, 200, { signerId: s.signerId, online: s.online });
    }

    m = path.match(/^\/api\/merchants\/([\w-]+)\/(revoke|reinstate)$/);
    if (m) {
      const mc = state.merchants.find((x) => x.merchantId === m[1]);
      if (!mc) return send(res, 404, { error: 'unknown merchant' });
      mc.revoked = m[2] === 'revoke';
      govLog(mc.revoked ? 'MERCHANT_REVOKED' : 'MERCHANT_REINSTATED', mc.merchantId, mc.name);
      return send(res, 200, mc);
    }

    m = path.match(/^\/api\/governance\/members\/([\w-]+)\/(revoke|reinstate)$/);
    if (m) {
      const mem = state.members.find((x) => x.signerId === m[1]);
      if (!mem) return send(res, 404, { error: 'unknown member' });
      mem.status = m[2] === 'revoke' ? 'REVOKED' : 'ACTIVE';
      const sig = state.consortium.signers.find((x) => x.signerId === m[1]);
      if (sig) sig.revoked = mem.status === 'REVOKED';
      refreshQuorum();
      govLog(mem.status === 'REVOKED' ? 'MEMBER_REVOKED' : 'MEMBER_REINSTATED', mem.signerId, mem.name);
      return send(res, 200, mem);
    }

    if (path === '/api/requests') {
      const requestId = startScenario('legit');
      return send(res, 202, { requestId });
    }

    return send(res, 404, { error: 'not found' });
  });
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ at: new Date().toISOString(), svc: 'mock-coordinator', evt: 'listening', port: PORT }));
});
