/**
 * Panel C — Reconciliation / internal conservation.
 * Counters + huge Δ tile + Recharts cumulative series + drill-down table.
 *
 * Chart palette re-validated with the dataviz six-checks validator against the
 * current panel surface #0E1729 (dark): #0AA87A / #2C9BE0 / #9D4EE8, all six
 * checks PASS. Deuteranopia separation is comfortable but the blue-violet pair
 * is inherently close under tritanopia, so series identity stays doubly encoded
 * via distinct dash patterns, stroke widths and labelled legend chips.
 *
 * This is a categorical palette keyed to entity, deliberately separate from the
 * status/chain tokens in index.css.
 */
import clsx from 'clsx';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import type { PipelineRecord, Snapshot } from '../types';
import { Card, EmptyState, ExplorerLink, NONE, PanelTitle, fmtTime, truncMiddle, CopyBtn } from './ui';

const SERIES = [
  { key: 'tokens' as const, label: 'Tokens issued', color: '#0AA87A', dash: undefined, width: 4.5 },
  { key: 'debits' as const, label: 'Confirmed debits', color: '#2C9BE0', dash: '8 5', width: 2 },
  { key: 'records' as const, label: 'On-chain records', color: '#9D4EE8', dash: '2 5', width: 2 },
];

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-edge-strong bg-panel-3 px-3 py-2 shadow-card">
      <div className="tnum mb-1 text-[11px] text-ink-faint">{fmtTime(String(label))}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-[12px]">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="text-ink-muted">{p.name}</span>
          <span className="tnum ml-auto pl-4 font-semibold text-ink">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

function Counter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
        <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">{label}</span>
      </div>
      <div className="tnum mt-1 text-4xl font-bold tracking-tight text-ink">{value}</div>
    </Card>
  );
}

function DrilldownRow({ rec }: { rec: PipelineRecord }) {
  return (
    <tr className="border-t border-edge text-[12px] hover:bg-white/3">
      <td className="tnum px-3 py-2 text-ink-faint">{fmtTime(rec.request.timestamp)}</td>
      <td className="px-3 py-2 font-medium text-ink">{rec.request.meterId}</td>
      <td className="tnum px-3 py-2 text-ink-muted">{rec.request.amountKwh} kWh</td>
      <td className="px-3 py-2">
        {rec.token ? (
          <span className="inline-flex items-center gap-0.5">
            <code className="font-mono text-local-soft" title={rec.token.nonce}>
              {truncMiddle(rec.token.nonce, 6, 4)}
            </code>
            <CopyBtn text={rec.token.nonce} />
          </span>
        ) : (
          NONE
        )}
      </td>
      <td className="px-3 py-2">
        {rec.debit ? (
          <span className="inline-flex items-center gap-0.5">
            <code className="font-mono text-local-soft" title={rec.debit.debitRef}>
              {rec.debit.debitRef}
            </code>
            <CopyBtn text={rec.debit.debitRef} />
          </span>
        ) : (
          NONE
        )}
      </td>
      <td className="px-3 py-2 text-ink-muted">{rec.signerSet ? rec.signerSet.join(' + ') : NONE}</td>
      <td className="px-3 py-2">{rec.ledger ? <ExplorerLink url={rec.ledger.explorerUrl} label="tx" /> : NONE}</td>
    </tr>
  );
}

export function ReconPanel({ snap }: { snap: Snapshot }) {
  const r = snap.reconciliation;
  const deltaBad = r.delta !== 0;
  const delivered = snap.requests.filter((q) => q.status === 'DELIVERED');
  const data = r.series.map((p) => ({ ...p }));

  return (
    <section>
      <PanelTitle
        title="Reconciliation: internal conservation"
        sub="Tokens issued ⇄ confirmed debits ⇄ on-chain records. The three series must never diverge."
      />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Counter label="Tokens issued" value={r.tokensIssued} color={SERIES[0].color} />
        <Counter label="Confirmed debits" value={r.confirmedDebits} color={SERIES[1].color} />
        <Counter label="On-chain records" value={r.onChainRecords} color={SERIES[2].color} />
        <Card alarmed={deltaBad} className={clsx('p-4', !deltaBad && 'border-ok/30')}>
          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
            Δ divergence
          </div>
          <div className={clsx('tnum mt-1 text-5xl font-bold tracking-tight', deltaBad ? 'text-bad-soft' : 'text-ok-soft')}>
            {r.delta}
          </div>
          <div className={clsx('mt-1 text-[11px] leading-snug', deltaBad ? 'text-bad-soft' : 'text-ink-faint')}>
            {deltaBad
              ? 'INTEGRITY FAULT: the pipeline leaked. Investigate immediately.'
              : 'Internal conservation holds. The pipeline is the only door.'}
          </div>
        </Card>
      </div>

      <Card className="mt-4 p-5">
        <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          <h3 className="text-[13px] font-semibold text-ink">Cumulative conservation series</h3>
          <div className="flex flex-wrap items-center gap-3">
            {SERIES.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                <svg width="22" height="6" aria-hidden>
                  <line x1="1" y1="3" x2="21" y2="3" stroke={s.color} strokeWidth={s.key === 'tokens' ? 4 : 2} strokeDasharray={s.dash} strokeLinecap="round" />
                </svg>
                {s.label}
              </span>
            ))}
          </div>
          <span className="ml-auto text-[11px] italic text-ink-faint">
            the three lines must overlay perfectly; that is the story
          </span>
        </div>
        {data.length === 0 ? (
          <EmptyState>No deliveries yet. The series plots one point per delivered token.</EmptyState>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="t"
                  tickFormatter={(v: string) => fmtTime(v)}
                  tick={{ fill: '#6B7F9E', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
                  minTickGap={48}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: '#6B7F9E', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.15)' }} />
                {SERIES.map((s) => (
                  <Line
                    key={s.key}
                    type="stepAfter"
                    dataKey={s.key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={s.width}
                    strokeDasharray={s.dash}
                    strokeLinecap="round"
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card className="mt-4 overflow-hidden">
        <div className="border-b border-edge px-5 py-3">
          <h3 className="text-[13px] font-semibold text-ink">Token drill-down</h3>
          <p className="text-[11px] text-ink-faint">every delivered token → its debit → its quorum → its immutable record</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-ink-faint">
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Meter</th>
                <th className="px-3 py-2 font-medium">Energy</th>
                <th className="px-3 py-2 font-medium">Token nonce</th>
                <th className="px-3 py-2 font-medium">Debit ref</th>
                <th className="px-3 py-2 font-medium">Signer set</th>
                <th className="px-3 py-2 font-medium">On-chain</th>
              </tr>
            </thead>
            <tbody>
              {delivered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-[12px] text-ink-faint">
                    No delivered tokens yet.
                  </td>
                </tr>
              )}
              {delivered.map((rec) => (
                <DrilldownRow key={rec.request.requestId} rec={rec} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}
