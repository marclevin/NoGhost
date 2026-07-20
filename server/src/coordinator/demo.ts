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
import type { BankMode, SignerId } from '../common/types.js';
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

/**
 * The operator's own bank/signer settings, captured before a scenario overrides
 * them. Restoring to this rather than to hardcoded defaults is what stops a
 * scenario from silently wiping whatever the presenter had dialled in by hand.
 */
interface ControlState {
  bankMode: BankMode;
  signers: Array<{ signerId: SignerId; online: boolean }>;
}

function captureControls(): ControlState {
  return {
    bankMode: store.getBankStatus().mode,
    signers: store.getConsortiumStatus().signers.map((s) => ({ signerId: s.signerId, online: s.online })),
  };
}

/**
 * Scenarios can overlap: the rail disables only the button that is running, so a
 * presenter can fire a second one while the first is still in flight. The
 * baseline is therefore captured once by the first scenario in a chain and
 * restored once by the last to finish, otherwise a later scenario would adopt an
 * earlier one's preconditions as "the operator's settings" and make them stick.
 */
let baseline: ControlState | null = null;
let inFlight = 0;

async function restoreControls(prev: ControlState): Promise<void> {
  if (store.getBankStatus().mode !== prev.bankMode) await setBankMode(prev.bankMode);
  for (const s of store.getConsortiumStatus().signers) {
    const want = prev.signers.find((p) => p.signerId === s.signerId);
    if (want && want.online !== s.online) await setSignerOnline(s.signerId, want.online);
  }
}

async function restorePreconditions(kind: ScenarioKind, merchantId: string): Promise<void> {
  try {
    // Merchant revocation is scoped to this one scenario, so it is always undone
    // here rather than deferred to the shared baseline.
    if (kind === 'revoked-merchant') store.setMerchantRevoked(merchantId, false, 'demo');

    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0 && baseline) {
      const prev = baseline;
      baseline = null;
      await restoreControls(prev);
    }
    await pollAllHealth();
  } catch {
    /* best effort — never crash the demo */
  } finally {
    if (inFlight === 0) store.setActiveScenario(null);
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

  // Refresh first so the capture reflects reality, not a health poll up to 3s
  // stale, then snapshot the operator's settings before overriding them.
  await pollAllHealth();
  if (inFlight === 0) baseline = captureControls();
  inFlight += 1;

  await applyPreconditions(kind, merchantId);
  await pollAllHealth();

  const record = store.createRecord({ requestId, meterId, amountKwh, merchantId, timestamp: new Date().toISOString() });
  store.setActiveScenario(kind);
  store.log('demo.scenario', { kind, requestId, meterId, merchantId, amountKwh });

  // Restore automatically once THIS request goes terminal, exactly once.
  let settled = false;
  let unsubscribe: () => void = () => {};
  let watchdog: NodeJS.Timeout | undefined;

  const settle = (): void => {
    if (settled) return;
    settled = true;
    unsubscribe();
    if (watchdog) clearTimeout(watchdog);
    void restorePreconditions(kind, merchantId);
  };

  unsubscribe = store.subscribe((ev) => {
    if (ev.type === 'request.updated' && ev.record.request.requestId === requestId && store.TERMINAL.has(ev.record.status)) {
      settle();
    }
  });

  // FR-17 guarantees a terminal state, so this should never fire. It exists
  // because inFlight wedging above zero would strand the operator's settings and
  // block every later restore, which is a far worse demo failure than a late one.
  watchdog = setTimeout(() => {
    store.log('demo.watchdog', { kind, requestId });
    settle();
  }, 90_000);
  watchdog.unref?.();

  void runPipeline(record);
  return { requestId, kind };
}
