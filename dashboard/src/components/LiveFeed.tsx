/** Panel A — Live Generation Feed: newest-first request cards with pipeline steppers. */
import type { Merchant, PipelineRecord, Snapshot } from '../types';
import { Stepper } from './Stepper';
import {
  BoltIcon,
  Card,
  Chip,
  EmptyState,
  ExplorerLink,
  PanelTitle,
  Spinner,
  fmtTime,
  fmtZar,
  priceZar,
  truncMiddle,
  type Tone,
} from './ui';

const WALL_LABEL: Record<string, string> = {
  WALL_1_BANK: 'Wall 1 — Bank',
  WALL_2_CONSORTIUM: 'Wall 2 — Consortium',
  LEDGER: 'Ledger',
  POLICY: 'Policy gate',
};

function statusChip(rec: PipelineRecord): { tone: Tone; label: string; busy?: boolean } {
  switch (rec.status) {
    case 'DELIVERED':
      return { tone: 'ok', label: 'DELIVERED' };
    case 'REJECTED':
      return { tone: 'bad', label: 'REJECTED' };
    case 'REJECTED_ABANDONED':
      return { tone: 'bad', label: 'ABANDONED — DEBIT REVERSED' };
    case 'PENDING':
      return { tone: 'info', label: 'AWAITING DEBIT', busy: true };
    case 'DEBIT_CONFIRMED':
      return { tone: 'info', label: 'IN CEREMONY', busy: true };
    case 'SIGNED':
      return { tone: 'ledger', label: 'WRITING TO LEDGER', busy: true };
    case 'RECORDED':
      return { tone: 'ledger', label: 'DELIVERING', busy: true };
    default:
      return { tone: 'muted', label: rec.status };
  }
}

function merchantName(merchants: Merchant[], id: string): string {
  return merchants.find((m) => m.merchantId === id)?.name ?? id;
}

function RequestCard({ rec, merchants }: { rec: PipelineRecord; merchants: Merchant[] }) {
  const chip = statusChip(rec);
  const rejected = rec.status === 'REJECTED' || rec.status === 'REJECTED_ABANDONED';
  const amount = rec.debit?.amount ?? priceZar(rec.request.amountKwh);
  return (
    <Card className={rejected ? 'card-in border-bad/35' : 'card-in'}>
      <div className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-1.5 font-semibold text-ink">
            <BoltIcon className="h-4 w-4 text-warn-soft" />
            {rec.request.meterId}
          </span>
          <span className="tnum text-sm text-ink">
            {rec.request.amountKwh} kWh
            <span className="ml-2 text-ink-muted">{fmtZar(amount)}</span>
          </span>
          <span className="text-sm text-ink-muted">{merchantName(merchants, rec.request.merchantId)}</span>
          <span className="ml-auto flex items-center gap-2">
            <span className="tnum text-[11px] text-ink-faint">{fmtTime(rec.request.timestamp)}</span>
            <Chip tone={chip.tone}>
              {chip.busy && <Spinner className="h-3 w-3" />}
              {chip.label}
            </Chip>
          </span>
        </div>

        <Stepper record={rec} />

        {rejected && rec.rejection && (
          <div className="mt-3 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-[12px] font-bold uppercase tracking-wider text-bad-soft">
                Blocked at {WALL_LABEL[rec.rejection.wall] ?? rec.rejection.wall}
              </span>
              <span className="text-[13px] text-ink">{rec.rejection.reason}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-muted">
              <span>
                Attribution: <span className="font-medium text-ink">{rec.rejection.attribution}</span>
              </span>
              {rec.debitReversed && (
                <span className="font-medium text-warn-soft">Debit reversed — customer refunded</span>
              )}
            </div>
          </div>
        )}

        {rec.status === 'DELIVERED' && rec.token && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-ok/25 bg-ok/8 px-3 py-2 text-[12px]">
            <span className="text-ink-muted">
              Token nonce{' '}
              <code className="font-mono text-ok-soft" title={rec.token.nonce}>
                {truncMiddle(rec.token.nonce, 8, 6)}
              </code>
            </span>
            {rec.signerSet && (
              <span className="text-ink-muted">
                Quorum <span className="font-medium text-ink">{rec.signerSet.join(' + ')}</span>
              </span>
            )}
            {rec.meterDelivery && (
              <span className="tnum text-ink-muted">
                Dispensed <span className="font-medium text-ink">{rec.meterDelivery.dispensedKwh} kWh</span>
              </span>
            )}
            {rec.ledger && <ExplorerLink url={rec.ledger.explorerUrl} />}
          </div>
        )}
      </div>
    </Card>
  );
}

export function LiveFeed({ snap }: { snap: Snapshot }) {
  return (
    <section>
      <PanelTitle
        title="Live Generation Feed"
        sub="Every token request, live — passing through both walls or stopped dead at one of them."
        right={
          <span className="tnum text-[12px] text-ink-faint">
            {snap.requests.length} request{snap.requests.length === 1 ? '' : 's'}
          </span>
        }
      />
      <div className="flex flex-col gap-3">
        {snap.requests.length === 0 && (
          <EmptyState>No requests yet — fire a scenario from the Demo Control panel.</EmptyState>
        )}
        {snap.requests.map((rec) => (
          <RequestCard key={rec.request.requestId} rec={rec} merchants={snap.merchants} />
        ))}
      </div>
    </section>
  );
}
