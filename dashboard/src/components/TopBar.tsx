/** Top bar: brand, tab navigation, connection dot, XRPL testnet badge, live clock, alerts bell. */
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { Alert } from '../types';
import type { ConnState } from '../store';
import { AlertsBell } from './Alerts';
import { Brand, Dot, type Tone } from './ui';

export type TabId = 'feed' | 'recon' | 'governance' | 'audit';

export const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'feed', label: 'Live Feed' },
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
    <header className="sticky top-0 z-40 bg-page/85 backdrop-blur">
      <div className="flex h-14 items-center gap-4 px-4 xl:px-6">
        <Brand />

        {/* tabs */}
        {/* overflow-y-hidden matters: overflow-x-auto alone promotes overflow-y to
            auto, so any sub-pixel overflow raises a vertical scrollbar in the strip.
            no-scrollbar keeps the tabs swipeable on narrow viewports without a bar. */}
        <nav className="no-scrollbar ml-4 flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={clsx(
                'relative whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium transition',
                tab === t.id
                  ? 'bg-local/10 text-local-soft'
                  : 'text-ink-muted hover:bg-white/5 hover:text-ink',
              )}
            >
              {t.label}
              {tab === t.id && (
                <span className="glow absolute inset-x-2.5 bottom-0 h-0.5 rounded-full bg-local text-local" />
              )}
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
          <span className="hidden items-center gap-1.5 rounded-full border border-ledger/40 bg-ledger/12 px-2.5 py-1 text-[11px] font-semibold tracking-wider text-ledger-soft sm:flex">
            <Dot tone="ledger" />
            XRPL TESTNET
          </span>
          <Clock />
          <AlertsBell alerts={alerts} />
        </div>
      </div>
      {/* Chain axis as a hairline: off-chain cyan bleeding into on-chain violet. */}
      <div className="h-px w-full bg-gradient-to-r from-local/60 via-edge-strong to-ledger/60" />
    </header>
  );
}
