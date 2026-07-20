/** Shared UI primitives: cards, chips, icons (inline SVG only), formatters. */
import { useState, type ReactNode, type SVGProps } from 'react';
import clsx from 'clsx';

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export const RATE_ZAR_PER_KWH = 2.5;
export const priceZar = (kwh: number): number => Math.round(kwh * RATE_ZAR_PER_KWH * 100) / 100;

export const fmtZar = (n: number): string =>
  `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Rendered in any cell that has no value yet. */
export const NONE = '·';

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return NONE;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NONE;
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return NONE;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NONE;
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString('en-GB', { hour12: false })}`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return fmtTime(iso);
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function truncMiddle(s: string, head = 8, tail = 6): string {
  if (!s) return '';
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// ---------------------------------------------------------------------------
// Icons (inline SVG, no deps)
// ---------------------------------------------------------------------------

type IconProps = SVGProps<SVGSVGElement>;

export const CheckIcon = (p: IconProps) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M3 8.5l3.2 3.2L13 4.5" />
  </svg>
);

export const XIcon = (p: IconProps) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

export const BellIcon = (p: IconProps) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M10 2.5a5 5 0 0 0-5 5v3l-1.5 2.8h13L15 10.5v-3a5 5 0 0 0-5-5zM8 15.5a2 2 0 0 0 4 0" />
  </svg>
);

export const LinkOutIcon = (p: IconProps) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M6.5 3.5H3.5v9h9v-3M9.5 2.5h4v4M13 3L7.5 8.5" />
  </svg>
);

export const CopyIcon = (p: IconProps) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </svg>
);

export const ShieldIcon = (p: IconProps) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M10 2.5l6.5 2.4v4.4c0 4-2.7 6.8-6.5 8.2-3.8-1.4-6.5-4.2-6.5-8.2V4.9L10 2.5z" />
  </svg>
);

export const BankIcon = (p: IconProps) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M2.5 8h15L10 3 2.5 8zM4 8v6M8 8v6M12 8v6M16 8v6M2.5 16.5h15" />
  </svg>
);

export const BoltIcon = (p: IconProps) => (
  <svg viewBox="0 0 20 20" fill="currentColor" {...p}>
    <path d="M11.3 1.5L3.8 11h4.4l-1 7.5L14.8 9h-4.5l1-7.5z" />
  </svg>
);

/**
 * NoGhost brand mark: a ghost glyph struck through.
 *
 * Draws its own tile so the slash can be knocked out against a known backdrop
 * (a plain diagonal over the silhouette turns to mush below ~20px). Colours come
 * from the theme vars, which resolve because this is inline SVG in the document.
 * The one copy that CANNOT share them is the favicon in index.html, since a
 * data: URI has no access to the page stylesheet — keep the two in sync by hand.
 */
export const GhostMark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} role="img" aria-label="NoGhost">
    <rect width="24" height="24" rx="6.5" fill="var(--color-page)" />
    <rect x="0.5" y="0.5" width="23" height="23" rx="6" fill="none" stroke="var(--color-edge-strong)" />
    <path
      d="M6.5 18V11a5.5 5.5 0 0 1 11 0v7l-2.75-1.75L12 18l-2.75-1.75L6.5 18Z"
      fill="none"
      stroke="var(--color-local)"
      strokeWidth={1.8}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
    {/* Sited so the strike consumes the right eye but clears the left one. Two
        surviving eyes is impossible for any centred diagonal, and zero eyes stops
        reading as a ghost at all, so one is the target, not a compromise. */}
    <circle cx="9.2" cy="10.6" r="1.1" fill="var(--color-local)" />
    <circle cx="14.8" cy="10.6" r="1.1" fill="var(--color-local)" />
    <path d="M4.7 19.3 19.3 4.7" stroke="var(--color-page)" strokeWidth={3.2} strokeLinecap="round" />
    <path d="M4.7 19.3 19.3 4.7" stroke="var(--color-bad)" strokeWidth={2.2} strokeLinecap="round" />
  </svg>
);

/** Mark + wordmark lockup. `lg` is the loading screen, default is the top bar. */
export function Brand({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const lg = size === 'lg';
  return (
    <div className="flex items-center gap-2.5">
      <GhostMark className={lg ? 'h-11 w-11' : 'h-9 w-9'} />
      <div className="leading-tight">
        <div className={clsx('font-bold tracking-wide text-ink', lg ? 'text-lg' : 'text-[13px]')}>
          No<span className="text-local">Ghost</span>
        </div>
        <div className={clsx('uppercase tracking-widest text-ink-faint', lg ? 'text-[11px]' : 'text-[10px]')}>
          Prepaid Token Authority
        </div>
      </div>
    </div>
  );
}

export const Spinner = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 20 20" fill="none" className={clsx('spin', className)}>
    <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeOpacity={0.25} strokeWidth={2.5} />
    <path d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" />
  </svg>
);

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
  alarmed = false,
}: {
  children: ReactNode;
  className?: string;
  alarmed?: boolean;
}) {
  return (
    <div
      className={clsx(
        'rounded-xl border bg-panel shadow-card',
        alarmed ? 'border-bad/60 alarm-glow' : 'border-edge',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PanelTitle({
  title,
  sub,
  right,
}: {
  title: string;
  sub?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
        {sub && <p className="mt-0.5 text-[13px] leading-snug text-ink-muted">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

/**
 * `local` and `ledger` are the two ends of the chain axis (off-chain cyan /
 * on-chain violet). `ok`/`bad` stay reserved for pass/fail so a verdict colour
 * can never be mistaken for a chain-location colour.
 */
export type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'local' | 'ledger' | 'muted';

const toneText: Record<Tone, string> = {
  ok: 'text-ok-soft',
  bad: 'text-bad-soft',
  warn: 'text-warn-soft',
  info: 'text-info',
  local: 'text-local-soft',
  ledger: 'text-ledger-soft',
  muted: 'text-ink-muted',
};
const toneBg: Record<Tone, string> = {
  ok: 'bg-ok/12 border-ok/35',
  bad: 'bg-bad/12 border-bad/35',
  warn: 'bg-warn/12 border-warn/35',
  info: 'bg-info/12 border-info/35',
  local: 'bg-local/12 border-local/35',
  ledger: 'bg-ledger/14 border-ledger/40',
  muted: 'bg-white/5 border-edge',
};

export function Chip({
  tone = 'muted',
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4',
        toneBg[tone],
        toneText[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = 'muted', pulse = false }: { tone?: Tone; pulse?: boolean }) {
  const bg: Record<Tone, string> = {
    ok: 'bg-ok text-ok',
    bad: 'bg-bad text-bad',
    warn: 'bg-warn text-warn',
    info: 'bg-info text-info',
    local: 'bg-local text-local',
    ledger: 'bg-ledger text-ledger',
    muted: 'bg-ink-faint text-ink-faint',
  };
  // `.glow` blooms in currentColor, hence the text-* alongside each bg-*.
  return (
    <span
      className={clsx('inline-block h-2 w-2 shrink-0 rounded-full', bg[tone], pulse && 'pulse glow')}
    />
  );
}

export function CopyBtn({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      title="Copy to clipboard"
      className={clsx(
        'inline-flex items-center rounded p-1 text-ink-faint transition hover:bg-white/10 hover:text-ink',
        className,
      )}
    >
      {copied ? <CheckIcon className="h-3.5 w-3.5 text-ok-soft" /> : <CopyIcon className="h-3.5 w-3.5" />}
    </button>
  );
}

export function Hash({ value, head = 10, tail = 8 }: { value: string; head?: number; tail?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <code className="tnum font-mono text-[12px] text-ink-muted" title={value}>
        {truncMiddle(value, head, tail)}
      </code>
      <CopyBtn text={value} />
    </span>
  );
}

/** The universal "this lives on-chain" affordance, hence always the ledger violet. */
export function ExplorerLink({ url, label = 'View on XRPL' }: { url: string; label?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-[12px] font-medium text-ledger transition hover:text-ledger-soft hover:underline"
    >
      {label}
      <LinkOutIcon className="h-3.5 w-3.5" />
    </a>
  );
}

/**
 * Teaches the chain axis once per panel so the cyan/violet split downstream reads
 * as meaning rather than decoration.
 */
export function ChainLegend({ className }: { className?: string }) {
  return (
    <span className={clsx('flex items-center gap-3 text-[11px] text-ink-muted', className)}>
      <span className="flex items-center gap-1.5">
        <Dot tone="local" />
        Off-chain
      </span>
      <span className="flex items-center gap-1.5">
        <Dot tone="ledger" />
        On-chain (XRPL)
      </span>
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-edge px-6 py-10 text-sm text-ink-faint">
      {children}
    </div>
  );
}
