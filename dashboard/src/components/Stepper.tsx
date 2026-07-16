/** Horizontal 5-step pipeline stepper: Request → Debit → Quorum 2/3 → Recorded → Delivered. */
import clsx from 'clsx';
import type { PipelineRecord, Wall } from '../types';
import { CheckIcon, XIcon } from './ui';

const STEPS = ['Request', 'Debit', 'Quorum 2/3', 'Recorded', 'Delivered'] as const;

type StepState = 'done' | 'active' | 'failed' | 'todo';

/** How many steps are complete for each non-terminal/terminal status. */
const PROGRESS: Record<PipelineRecord['status'], number> = {
  PENDING: 1,
  DEBIT_CONFIRMED: 2,
  SIGNED: 3,
  RECORDED: 4,
  DELIVERED: 5,
  REJECTED: 0, // resolved via wall below
  REJECTED_ABANDONED: 0,
};

const WALL_STEP: Record<Wall, number> = {
  POLICY: 0,
  WALL_1_BANK: 1,
  WALL_2_CONSORTIUM: 2,
  LEDGER: 3,
};

export function stepStates(rec: PipelineRecord): StepState[] {
  if (rec.status === 'REJECTED' || rec.status === 'REJECTED_ABANDONED') {
    const failAt = rec.rejection ? WALL_STEP[rec.rejection.wall] : 1;
    return STEPS.map((_, i) => (i < failAt ? 'done' : i === failAt ? 'failed' : 'todo'));
  }
  const done = PROGRESS[rec.status];
  return STEPS.map((_, i) => (i < done ? 'done' : i === done ? 'active' : 'todo'));
}

function StepDot({ state }: { state: StepState }) {
  return (
    <span
      className={clsx(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
        state === 'done' && 'border-ok/60 bg-ok/20 text-ok-soft',
        state === 'active' && 'border-info/70 bg-info/15 text-info ring-pulse',
        state === 'failed' && 'border-bad/70 bg-bad/20 text-bad-soft',
        state === 'todo' && 'border-edge-strong bg-white/5 text-ink-faint',
      )}
    >
      {state === 'done' && <CheckIcon className="h-3 w-3" />}
      {state === 'failed' && <XIcon className="h-3 w-3" />}
      {state === 'active' && <span className="h-1.5 w-1.5 rounded-full bg-info pulse" />}
      {state === 'todo' && <span className="h-1.5 w-1.5 rounded-full bg-ink-faint/50" />}
    </span>
  );
}

export function Stepper({ record, compact = false }: { record: PipelineRecord; compact?: boolean }) {
  const states = stepStates(record);
  return (
    <div className="flex w-full items-start" role="list" aria-label="pipeline progress">
      {STEPS.map((label, i) => {
        const st = states[i];
        const nextDone = i < STEPS.length - 1 && (states[i + 1] === 'done' || states[i + 1] === 'failed' || states[i + 1] === 'active');
        return (
          <div key={label} role="listitem" className={clsx('flex items-start', i < STEPS.length - 1 && 'flex-1')}>
            <div className="flex flex-col items-center gap-1">
              <StepDot state={st} />
              {!compact && (
                <span
                  className={clsx(
                    'whitespace-nowrap text-[10px] font-medium leading-3 tracking-wide',
                    st === 'done' && 'text-ok-soft/90',
                    st === 'active' && 'text-info',
                    st === 'failed' && 'text-bad-soft',
                    st === 'todo' && 'text-ink-faint',
                  )}
                >
                  {label}
                </span>
              )}
            </div>
            {i < STEPS.length - 1 && (
              <div className="mx-1.5 mt-2.5 h-0.5 flex-1 overflow-hidden rounded bg-white/8">
                <div
                  className={clsx(
                    'h-full rounded transition-all duration-500',
                    st === 'done' && nextDone ? 'w-full bg-ok/60' : st === 'done' ? 'w-1/2 bg-ok/40' : 'w-0',
                  )}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
