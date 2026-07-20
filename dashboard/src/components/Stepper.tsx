/**
 * Horizontal on-chain pipeline stepper:
 * Request → Debit → Published → Approvals 2/3 → Quorum sign → Receipt → Delivered.
 */
import clsx from 'clsx';
import type { PipelineRecord, Wall } from '../types';
import { CheckIcon, XIcon } from './ui';

const STEPS = ['Request', 'Debit', 'Published', 'Approvals 2/3', 'Quorum sign', 'Receipt', 'Delivered'] as const;

/**
 * Which stages are witnessed on the XRPL. This drives the whole colour story:
 * a step is painted violet if it happens on-chain and cyan if it happens inside
 * our own trust boundary, whether it is complete or currently executing. Green
 * and red are deliberately absent here except for outright failure, so "where"
 * and "did it pass" never compete for the same hue.
 */
const CHAIN_STEP = [false, false, true, true, false, true, false] as const;

type StepState = 'done' | 'done-chain' | 'active' | 'active-chain' | 'failed' | 'todo';

/** How many steps are complete for each status (index into STEPS). */
const PROGRESS: Record<PipelineRecord['status'], number> = {
  PENDING: 1, // Request done
  DEBIT_CONFIRMED: 2, // Debit done
  PUBLISHED: 3, // Published done
  APPROVED: 4, // Approvals done
  SIGNED: 5, // Quorum sign done
  RECORDED: 6, // Receipt done
  DELIVERED: 7, // all done
  REJECTED: 0, // resolved via wall below
  REJECTED_ABANDONED: 0,
};

const WALL_STEP: Record<Wall, number> = {
  POLICY: 0, // Request
  WALL_1_BANK: 1, // Debit
  WALL_2_CONSORTIUM: 3, // Approvals / Quorum
  LEDGER: 5, // Published / Receipt (on-chain write)
};

export function stepStates(rec: PipelineRecord): StepState[] {
  const doneState = (i: number): StepState => (CHAIN_STEP[i] ? 'done-chain' : 'done');
  const activeState = (i: number): StepState => (CHAIN_STEP[i] ? 'active-chain' : 'active');
  if (rec.status === 'REJECTED' || rec.status === 'REJECTED_ABANDONED') {
    const failAt = rec.rejection ? WALL_STEP[rec.rejection.wall] : 1;
    return STEPS.map((_, i) => (i < failAt ? doneState(i) : i === failAt ? 'failed' : 'todo'));
  }
  const done = PROGRESS[rec.status];
  return STEPS.map((_, i) => (i < done ? doneState(i) : i === done ? activeState(i) : 'todo'));
}

const isDoneState = (s: StepState) => s === 'done' || s === 'done-chain';
const isActiveState = (s: StepState) => s === 'active' || s === 'active-chain';

function StepDot({ state }: { state: StepState }) {
  return (
    <span
      className={clsx(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
        state === 'done' && 'border-local/60 bg-local/20 text-local-soft',
        state === 'done-chain' && 'border-ledger/60 bg-ledger/20 text-ledger-soft',
        // ring-pulse blooms in currentColor, so the halo matches the track.
        state === 'active' && 'ring-pulse border-local/80 bg-local/15 text-local',
        state === 'active-chain' && 'ring-pulse border-ledger/80 bg-ledger/15 text-ledger',
        state === 'failed' && 'border-bad/70 bg-bad/25 text-bad-soft',
        state === 'todo' && 'border-edge-strong bg-white/5 text-ink-faint',
      )}
    >
      {isDoneState(state) && <CheckIcon className="h-3 w-3" />}
      {state === 'failed' && <XIcon className="h-3 w-3" />}
      {isActiveState(state) && <span className="pulse h-1.5 w-1.5 rounded-full bg-current" />}
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
        const isDone = isDoneState(st);
        const next = states[i + 1];
        const nextDone =
          i < STEPS.length - 1 && (isDoneState(next) || isActiveState(next) || next === 'failed');
        return (
          <div key={label} role="listitem" className={clsx('flex items-start', i < STEPS.length - 1 && 'flex-1')}>
            <div className="flex flex-col items-center gap-1">
              <StepDot state={st} />
              {!compact && (
                <span
                  className={clsx(
                    'whitespace-nowrap text-[10px] font-medium leading-3 tracking-wide',
                    st === 'done' && 'text-local-soft/90',
                    st === 'done-chain' && 'text-ledger-soft/90',
                    st === 'active' && 'text-local',
                    st === 'active-chain' && 'text-ledger',
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
                    isDone && nextDone ? 'w-full' : isDone ? 'w-1/2' : 'w-0',
                    isDone && (st === 'done-chain' ? 'bg-ledger/60' : 'bg-local/60'),
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
