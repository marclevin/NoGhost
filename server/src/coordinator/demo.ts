/**
 * Scripted demo scenarios (§6.3 / §8) — the presenter's spine.
 *
 *   legit              → bank CONFIRM, all signers online, expect DELIVERED, Δ = 0
 *   ghost              → bank DECLINE, expect REJECTED at Wall 1 + critical alert
 *   collusion-short    → only utility online, expect rejection at Wall 2 (below threshold)
 *   forged-attestation → bank OMIT_SIGNATURE, expect REJECTED at Wall 1 on FR-3
 *                        verification. Note this is caught by the coordinator's own
 *                        check against the pinned bank key, before Wall 2 is reached.
 *   revoked-merchant   → merchant revoked first, expect rejection at the POLICY gate
 *                        before any funds movement or signer contact (FR-19)
 *
 * Preconditions are set before submission and restored automatically once the
 * demo request reaches a terminal state. Everything is best-effort: if the
 * bank/signers are down the pipeline itself degrades gracefully (FR-D2).
 */
import { randomUUID } from 'node:crypto';
import { SIGNERS } from '../common/config.js';
import { pollAllHealth, setBankMode, setSignerOnline } from './health.js';
import { runPipeline } from './pipeline.js';
import * as store from './store.js';

export type ScenarioKind =
  | 'legit'
  | 'ghost'
  | 'collusion-short'
  | 'forged-attestation'
  | 'revoked-merchant';

export const SCENARIO_KINDS: ScenarioKind[] = [
  'legit',
  'ghost',
  'collusion-short',
  'forged-attestation',
  'revoked-merchant',
];

const METER_IDS = ['MTR-1001', 'MTR-1002', 'MTR-1003', 'MTR-1004', 'MTR-1005', 'MTR-1006'];
const MERCHANT_IDS = ['MER-001', 'MER-002', 'MER-003'];
let rotation = 0;

/** kWh submitted per scenario, so each button is distinguishable in the feed. */
const AMOUNT_KWH: Record<ScenarioKind, number> = {
  legit: 50,
  ghost: 30,
  'collusion-short': 40,
  'forged-attestation': 60,
  'revoked-merchant': 25,
};

/**
 * `merchantId` is the merchant this run will submit as. revoked-merchant has to
 * revoke that exact one, which is why the caller picks it before we run.
 */
async function applyPreconditions(kind: ScenarioKind, merchantId: string): Promise<void> {
  switch (kind) {
    case 'legit':
      await setBankMode('CONFIRM');
      await Promise.all(SIGNERS.map((s) => setSignerOnline(s.signerId, true)));
      break;
    case 'ghost':
      await setBankMode('DECLINE');
      break;
    case 'collusion-short':
      await setBankMode('CONFIRM');
      await setSignerOnline('utility', true);
      await setSignerOnline('city-a', false);
      await setSignerOnline('city-b', false);
      break;
    case 'forged-attestation':
      // The bank answers 200 OK with a syntactically valid but unsigned
      // attestation (64 zero bytes). Signers must be up so it is unambiguous
      // that the FR-3 pinned-key check is what stops it, not a missing quorum.
      await setBankMode('OMIT_SIGNATURE');
      await Promise.all(SIGNERS.map((s) => setSignerOnline(s.signerId, true)));
      break;
    case 'revoked-merchant':
      await setBankMode('CONFIRM');
      await Promise.all(SIGNERS.map((s) => setSignerOnline(s.signerId, true)));
      store.setMerchantRevoked(merchantId, true, 'demo');
      break;
  }
}

async function restorePreconditions(kind: ScenarioKind, merchantId: string): Promise<void> {
  try {
    if (kind === 'ghost' || kind === 'forged-attestation') await setBankMode('CONFIRM');
    if (kind === 'collusion-short') {
      await setSignerOnline('city-a', true);
      await setSignerOnline('city-b', true);
    }
    if (kind === 'revoked-merchant') store.setMerchantRevoked(merchantId, false, 'demo');
    await pollAllHealth();
  } catch {
    /* best effort — never crash the demo */
  } finally {
    store.setActiveScenario(null);
    store.log('demo.restored', { kind });
  }
}

export async function runScenario(kind: ScenarioKind): Promise<{ requestId: string; kind: ScenarioKind }> {
  // Selection happens first: revoked-merchant needs to revoke the very merchant
  // this request will be submitted under, so preconditions need to know it.
  const meterId = METER_IDS[rotation % METER_IDS.length];
  const merchantId = MERCHANT_IDS[rotation % MERCHANT_IDS.length];
  rotation += 1;
  const amountKwh = AMOUNT_KWH[kind];
  const requestId = `REQ-DEMO-${randomUUID().slice(0, 8)}`;

  await applyPreconditions(kind, merchantId);
  await pollAllHealth();

  const record = store.createRecord({ requestId, meterId, amountKwh, merchantId, timestamp: new Date().toISOString() });
  store.setActiveScenario(kind);
  store.log('demo.scenario', { kind, requestId, meterId, merchantId, amountKwh });

  // restore preconditions automatically when THIS request goes terminal
  const unsubscribe = store.subscribe((ev) => {
    if (ev.type === 'request.updated' && ev.record.request.requestId === requestId && store.TERMINAL.has(ev.record.status)) {
      unsubscribe();
      void restorePreconditions(kind, merchantId);
    }
  });

  void runPipeline(record);
  return { requestId, kind };
}
