/** Alert system: sliding toasts + bell dropdown listing the persistent alert history. */
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { Alert } from '../types';
import type { StoreAction } from '../store';
import { BellIcon, Chip, XIcon, fmtTime, type Tone } from './ui';

const SEV_TONE: Record<Alert['severity'], Tone> = { info: 'info', warning: 'warn', critical: 'bad' };
const SEV_BORDER: Record<Alert['severity'], string> = {
  info: 'border-info/40',
  warning: 'border-warn/50',
  critical: 'border-bad/60',
};

function AlertBody({ alert, compact = false }: { alert: Alert; compact?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <Chip tone={SEV_TONE[alert.severity]}>{alert.severity.toUpperCase()}</Chip>
        {alert.wall && <span className="text-[10px] font-semibold tracking-wider text-ink-faint">{alert.wall}</span>}
        <span className="tnum ml-auto text-[10px] text-ink-faint">{fmtTime(alert.at)}</span>
      </div>
      <div className="mt-1 text-[13px] font-semibold leading-snug text-ink">{alert.title}</div>
      {!compact && <div className="mt-0.5 text-[12px] leading-snug text-ink-muted">{alert.message}</div>}
      <div className="mt-0.5 text-[11px] text-ink-faint">
        attribution: <span className="font-medium text-ink-muted">{alert.attribution}</span>
      </div>
    </div>
  );
}

function Toast({ alert, onDismiss }: { alert: Alert; onDismiss: () => void }) {
  useEffect(() => {
    const ttl = alert.severity === 'critical' ? 15000 : 7000;
    const t = window.setTimeout(onDismiss, ttl);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      className={clsx(
        'toast-in pointer-events-auto flex w-[340px] items-start gap-2 rounded-xl border bg-panel-2 p-3 shadow-card',
        SEV_BORDER[alert.severity],
        alert.severity === 'critical' && 'alarm-glow',
      )}
      role="alert"
    >
      <AlertBody alert={alert} />
      <button type="button" onClick={onDismiss} className="shrink-0 rounded p-1 text-ink-faint hover:bg-white/10 hover:text-ink">
        <XIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function Toasts({ toasts, dispatch }: { toasts: Alert[]; dispatch: React.Dispatch<StoreAction> }) {
  return (
    <div className="pointer-events-none fixed right-4 top-16 z-50 flex flex-col gap-2">
      {toasts.map((a) => (
        <Toast key={a.id} alert={a} onDismiss={() => dispatch({ type: 'toast.dismiss', id: a.id })} />
      ))}
    </div>
  );
}

export function AlertsBell({ alerts }: { alerts: Alert[] }) {
  const [open, setOpen] = useState(false);
  // Track "seen" by alert identity, not array length: the list is capped in the
  // store, so once at the cap length stays constant and new alerts would never
  // raise the badge. IDs are stable (uuid), so any alert not seen since the bell
  // was last opened counts as unseen — even after the cap evicts older ones.
  const [seenIds, setSeenIds] = useState<Set<string>>(() => new Set());
  const ref = useRef<HTMLDivElement>(null);
  const unseenAlerts = alerts.filter((a) => !seenIds.has(a.id));
  const unseen = unseenAlerts.length;
  const hasCritical = unseenAlerts.some((a) => a.severity === 'critical');

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setSeenIds(new Set(alerts.map((a) => a.id)));
        }}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-edge bg-white/4 text-ink-muted transition hover:bg-white/8 hover:text-ink"
        title="Alerts"
      >
        <BellIcon className="h-4.5 w-4.5" />
        {unseen > 0 && (
          <span
            className={clsx(
              'tnum absolute -right-1.5 -top-1.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white',
              hasCritical ? 'bg-bad pulse' : 'bg-warn text-black',
            )}
          >
            {unseen}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 max-h-[70vh] w-[380px] overflow-y-auto rounded-xl border border-edge-strong bg-panel-2 shadow-card">
          <div className="sticky top-0 border-b border-edge bg-panel-2 px-4 py-2.5 text-[12px] font-bold uppercase tracking-wider text-ink-muted">
            Alerts ({alerts.length})
          </div>
          {alerts.length === 0 && <p className="px-4 py-8 text-center text-[12px] text-ink-faint">No alerts.</p>}
          <ul className="divide-y divide-edge">
            {alerts.map((a) => (
              <li key={a.id} className="flex items-start gap-2 px-4 py-3">
                <AlertBody alert={a} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
