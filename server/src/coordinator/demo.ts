/**
 * Scripted demo scenarios (§6.3 / §8) — the presenter's spine.
 *
 *   legit           → bank CONFIRM, all signers online, expect DELIVERED, Δ = 0
 *   ghost           → bank DECLINE, expect REJECTED at Wall 1 + critical alert
 *   collusion-short → only utility online, expect rejection at Wall 2 (below threshold)
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

export type ScenarioKind = 'legit' | 'ghost' | 'collusion-short';

export const SCENARIO_KINDS: ScenarioKind[] = ['legit', 'ghost', 'collusion-short'];

const METER_IDS = ['MTR-1001', 'MTR-1002', 'MTR-1003', 'MTR-1004', 'MTR-1005', 'MTR-1006'];
const MERCHANT_IDS = ['MER-001', 'MER-002', 'MER-003'];
let rotation = 0;

async function applyPreconditions(kind: ScenarioKind): Promise<void> {
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
  }
}

async function restorePreconditions(kind: ScenarioKind): Promise<void> {
  try {
    if (kind === 'ghost') await setBankMode('CONFIRM');
    if (kind === 'collusion-short') {
      await setSignerOnline('city-a', true);
      await setSignerOnline('city-b', true);
    }
    await pollAllHealth();
  } catch {
    /* best effort — never crash the demo */
  } finally {
    store.setActiveScenario(null);
    store.log('demo.restored', { kind });
  }
}

export async function runScenario(kind: ScenarioKind): Promise<{ requestId: string; kind: ScenarioKind }> {
  await applyPreconditions(kind);
  await pollAllHealth();

  const meterId = METER_IDS[rotation % METER_IDS.length];
  const merchantId = MERCHANT_IDS[rotation % MERCHANT_IDS.length];
  rotation += 1;
  const amountKwh = kind === 'legit' ? 50 : kind === 'ghost' ? 30 : 40;
  const requestId = `REQ-DEMO-${randomUUID().slice(0, 8)}`;

  const record = store.createRecord({ requestId, meterId, amountKwh, merchantId, timestamp: new Date().toISOString() });
  store.setActiveScenario(kind);
  store.log('demo.scenario', { kind, requestId, meterId, merchantId, amountKwh });

  // restore preconditions automatically when THIS request goes terminal
  const unsubscribe = store.subscribe((ev) => {
    if (ev.type === 'request.updated' && ev.record.request.requestId === requestId && store.TERMINAL.has(ev.record.status)) {
      unsubscribe();
      void restorePreconditions(kind);
    }
  });

  void runPipeline(record);
  return { requestId, kind };
}
