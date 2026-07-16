/** Top bar: brand, tab navigation, connection dot, XRPL testnet badge, live clock, alerts bell. */
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { Alert } from '../types';
import type { ConnState } from '../store';
import { AlertsBell } from './Alerts';
import { Dot, type Tone } from './ui';

export type TabId = 'feed' | 'walls' | 'recon' | 'governance' | 'audit';

export const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'feed', label: 'Live Feed' },
  { id: 'walls', label: 'Two Walls' },
  { id: 'recon', label: 'Reconciliation' },
  { id: 'governance', label: 'Governance' },
  { id: 'audit', label: 'Audit Trail' },
];

const CONN_INFO: Record<ConnState, { tone: Tone; label: string }> = {
  live: { tone: 'ok', label: 'LIVE' },
  polling: { tone: 'warn', label: 'POLLING' },
  connecting: { tone: 'info', label: 'CONNECTING' },
  offline: { tone: 'bad', label: 'OFFLINE' },
};

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <span className="tnum hidden text-[13px] font-medium text-ink-muted md:block">
      {now.toLocaleTimeString('en-GB', { hour12: false })}
    </span>
  );
}

export function TopBar({
  tab,
  onTab,
  conn,
  alerts,
}: {
  tab: TabId;
  onTab: (t: TabId) => void;
  conn: ConnState;
  alerts: Alert[];
}) {
  const c = CONN_INFO[conn];
  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-page/85 backdrop-blur">
      <div className="flex h-14 items-center gap-4 px-4 xl:px-6">
        {/* brand */}
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center gap-[3px] rounded-lg border border-edge-strong bg-panel-2 p-1.5">
            <span className="h-full w-[5px] rounded-sm bg-ok" />
            <span className="h-full w-[5px] rounded-sm bg-info" />
          </span>
          <div className="leading-tight">
            <div className="text-[13px] font-bold tracking-wide text-ink">TWO WALLS</div>
            <div className="text-[10px] uppercase tracking-widest text-ink-faint">Prepaid Token Authority</div>
          </div>
        </div>

        {/* tabs */}
        <nav className="ml-4 flex min-w-0 items-center gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onTab(t.id)}
              className={clsx(
                'whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium transition',
                tab === t.id ? 'bg-white/10 text-ink' : 'text-ink-muted hover:bg-white/5 hover:text-ink',
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1.5 rounded-full border border-edge bg-white/4 px-2.5 py-1 text-[11px] font-semibold tracking-wider">
            <Dot tone={c.tone} pulse={conn === 'live' || conn === 'connecting'} />
            <span
              className={clsx(
                c.tone === 'ok' && 'text-ok-soft',
                c.tone === 'warn' && 'text-warn-soft',
                c.tone === 'bad' && 'text-bad-soft',
                c.tone === 'info' && 'text-info',
              )}
            >
              {c.label}
            </span>
          </span>
          <span className="hidden items-center gap-1.5 rounded-full border border-ledger/35 bg-ledger/10 px-2.5 py-1 text-[11px] font-semibold tracking-wider text-ledger sm:flex">
            XRPL TESTNET
          </span>
          <Clock />
          <AlertsBell alerts={alerts} />
        </div>
      </div>
    </header>
  );
}
