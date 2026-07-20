/** Demo Control rail (FRD §6.3), always visible: scenario buttons + raw bank/signer toggles. */
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { api, type ScenarioKind } from '../api';
import type { BankMode, PipelineRecord, Snapshot } from '../types';
import { Chip, Dot, Spinner, XIcon, CheckIcon, wallLabel } from './ui';

interface ScenarioDef {
  kind: ScenarioKind;
  title: string;
  desc: string;
  accent: string;
  expected: string;
}

const SCENARIOS: ScenarioDef[] = [
  {
    kind: 'legit',
    title: 'Legitimate purchase',
    desc: 'Bank confirms, quorum signs, token delivered.',
    accent: 'border-ok/40 hover:bg-ok/10',
    expected: 'green across both walls',
  },
  {
    kind: 'ghost',
    title: 'Insider ghost-vend',
    desc: 'Bank withholds the debit, so the token is never born.',
    accent: 'border-bad/40 hover:bg-bad/10',
    expected: 'blocked at Wall 1',
  },
  {
    kind: 'collusion-short',
    title: 'Collusion short',
    desc: 'Only 1 of 3 signers, so one insider holds a useless fragment.',
    accent: 'border-warn/40 hover:bg-warn/10',
    expected: 'blocked at Wall 2',
  },
  {
    kind: 'forged-attestation',
    title: 'Compromised bank',
    desc: 'The bank forges a confirmation. The pinned-key check catches it.',
    accent: 'border-bad/40 hover:bg-bad/10',
    expected: 'blocked at Wall 1',
  },
  {
    kind: 'revoked-merchant',
    title: 'Revoked merchant',
    desc: 'A revoked merchant is stopped at the policy gate, before any debit.',
    accent: 'border-warn/40 hover:bg-warn/10',
    expected: 'blocked at the policy gate',
  },
];

const BANK_MODES: BankMode[] = ['CONFIRM', 'DECLINE', 'OMIT_SIGNATURE', 'TIMEOUT'];

type RunState =
  | { phase: 'idle' }
  | { phase: 'inflight'; requestId?: string }
  | { phase: 'done'; ok: boolean; label: string }
  | { phase: 'error'; label: string };

function isTerminal(rec: PipelineRecord): boolean {
  return rec.status === 'DELIVERED' || rec.status === 'REJECTED' || rec.status === 'REJECTED_ABANDONED';
}

function outcomeOf(rec: PipelineRecord): { ok: boolean; label: string } {
  if (rec.status === 'DELIVERED') return { ok: true, label: 'DELIVERED · token issued, Δ stays 0' };
  const wall = rec.rejection ? wallLabel(rec.rejection.wall) : 'unknown';
  // Match the Live Feed verb (statusChip: 'ABANDONED · DEBIT REVERSED') so the
  // two surfaces agree for a request whose terminal status is REJECTED_ABANDONED.
  if (rec.status === 'REJECTED_ABANDONED') return { ok: false, label: `ABANDONED at ${wall} · debit reversed` };
  return { ok: false, label: `REJECTED at ${wall}` };
}

function ScenarioButton({ def, snap }: { def: ScenarioDef; snap: Snapshot }) {
  const [run, setRun] = useState<RunState>({ phase: 'idle' });
  const timeoutRef = useRef<number>();

  // watch the store for our request reaching a terminal state
  useEffect(() => {
    if (run.phase !== 'inflight' || !run.requestId) return;
    const rec = snap.requests.find((r) => r.request.requestId === run.requestId);
    if (rec && isTerminal(rec)) {
      window.clearTimeout(timeoutRef.current);
      const o = outcomeOf(rec);
      setRun({ phase: 'done', ...o });
    }
  }, [snap.requests, run]);

  useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  const fire = async () => {
    setRun({ phase: 'inflight' });
    const res = await api.scenario(def.kind);
    if (!res.ok || !res.data?.requestId) {
      setRun({ phase: 'error', label: res.error ?? 'coordinator unreachable' });
      return;
    }
    setRun({ phase: 'inflight', requestId: res.data.requestId });
    timeoutRef.current = window.setTimeout(
      () => setRun((r) => (r.phase === 'inflight' ? { phase: 'error', label: 'no terminal state observed (45s)' } : r)),
      45000,
    );
  };

  const busy = run.phase === 'inflight';
  return (
    <div className={clsx('rounded-xl border bg-white/3 transition', def.accent)}>
      <button
        type="button"
        disabled={busy}
        onClick={() => void fire()}
        className="block w-full px-3.5 py-3 text-left disabled:cursor-wait"
      >
        <span className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-ink">{def.title}</span>
          {busy && <Spinner className="ml-auto h-4 w-4 text-local" />}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-ink-muted">{def.desc}</span>
        <span className="mt-1 block text-[10px] uppercase tracking-wider text-ink-faint">
          expect: {def.expected}
        </span>
      </button>
      {(run.phase === 'done' || run.phase === 'error') && (
        <div
          className={clsx(
            'flex items-center gap-1.5 border-t px-3.5 py-2 text-[11px] font-medium',
            run.phase === 'done' && run.ok
              ? 'border-ok/25 text-ok-soft'
              : run.phase === 'done'
                ? 'border-bad/25 text-bad-soft'
                : 'border-warn/25 text-warn-soft',
          )}
        >
          {run.phase === 'done' && run.ok ? <CheckIcon className="h-3 w-3 shrink-0" /> : <XIcon className="h-3 w-3 shrink-0" />}
          <span className="leading-snug">{run.label}</span>
          <button
            type="button"
            onClick={() => setRun({ phase: 'idle' })}
            className="ml-auto text-ink-faint hover:text-ink"
            title="dismiss"
          >
            <XIcon className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

export function DemoControls({ snap }: { snap: Snapshot }) {
  const [modeBusy, setModeBusy] = useState(false);
  const [signerBusy, setSignerBusy] = useState<string | null>(null);

  return (
    <aside className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h2 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-wider text-ink">
          Demo Control
          {snap.demo.activeScenario && (
            <Chip tone="local">
              <Spinner className="h-3 w-3" />
              {snap.demo.activeScenario}
            </Chip>
          )}
        </h2>
        <p className="mt-0.5 text-[11px] leading-snug text-ink-faint">
          The scripted spine of the live demo: fire an attack, watch a wall stop it.
        </p>
      </div>

      <div className="flex flex-col gap-2.5">
        {SCENARIOS.map((s) => (
          <ScenarioButton key={s.kind} def={s} snap={snap} />
        ))}
      </div>

      <hr className="border-edge" />

      <div>
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-ink-muted">Raw controls</h3>
        <label className="mt-2 block text-[11px] font-medium text-ink-faint" htmlFor="bank-mode">
          Bank mode
        </label>
        <select
          id="bank-mode"
          value={snap.bank.mode}
          disabled={modeBusy}
          onChange={(e) => {
            setModeBusy(true);
            void api.bankMode(e.target.value as BankMode).finally(() => setModeBusy(false));
          }}
          className={clsx(
            'mt-1 w-full rounded-lg border bg-panel-2 px-2.5 py-1.5 text-[13px] font-medium text-ink outline-none transition focus:border-info/60',
            snap.bank.mode === 'CONFIRM' ? 'border-edge' : 'border-bad/50',
          )}
        >
          {BANK_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <div className="mt-3 text-[11px] font-medium text-ink-faint">Signers</div>
        <div className="mt-1 flex flex-col gap-1.5">
          {snap.consortium.signers.map((s) => (
            <button
              key={s.signerId}
              type="button"
              disabled={signerBusy === s.signerId}
              onClick={() => {
                setSignerBusy(s.signerId);
                void api.signerOnline(s.signerId, !s.online).finally(() => setSignerBusy(null));
              }}
              className="flex items-center gap-2 rounded-lg border border-edge bg-white/3 px-2.5 py-1.5 text-left transition hover:bg-white/6 disabled:opacity-50"
              title={s.online ? 'Take offline' : 'Bring online'}
            >
              {/* Not pulsed: this is a static online/offline boolean, and an
                  always-animating dot reads as activity that isn't happening.
                  Pulsing stays reserved for the live connection indicator. */}
              <Dot tone={s.online ? 'ok' : 'bad'} />
              <span className="text-[12px] font-medium text-ink">{s.name}</span>
              {signerBusy === s.signerId && <Spinner className="h-3 w-3 text-local" />}
              {/* toggle track */}
              <span
                className={clsx(
                  'ml-auto inline-flex h-4 w-8 items-center rounded-full border px-0.5 transition',
                  s.online ? 'justify-end border-ok/50 bg-ok/25' : 'justify-start border-edge-strong bg-white/8',
                )}
              >
                <span className={clsx('h-3 w-3 rounded-full transition', s.online ? 'bg-ok-soft' : 'bg-ink-faint')} />
              </span>
            </button>
          ))}
        </div>
      </div>

      <p className="mt-auto pt-2 text-[10px] leading-snug text-ink-faint/80">
        UZH proof-of-concept. FROST 2-of-3 over Ed25519, XRPL testnet witness. Insider fraud impossible by
        construction, not by audit.
      </p>
    </aside>
  );
}
