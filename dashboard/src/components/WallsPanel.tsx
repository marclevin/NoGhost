/** Panel B — Two Walls Status: bank tile + consortium tile with per-signer health chips. */
import clsx from 'clsx';
import type { BankMode, SignerHealth, Snapshot } from '../types';
import { ago, BankIcon, Card, Chip, Dot, PanelTitle, ShieldIcon, truncMiddle } from './ui';

const MODE_INFO: Record<BankMode, { label: string; tone: 'ok' | 'bad' | 'warn'; note: string }> = {
  CONFIRM: { label: 'CONFIRM', tone: 'ok', note: 'Debits confirmed and signed — normal operation.' },
  DECLINE: { label: 'DECLINE', tone: 'bad', note: 'Bank declining all debits — no funds movement authorised.' },
  OMIT_SIGNATURE: { label: 'OMIT SIGNATURE', tone: 'bad', note: 'Bank omitting its attestation — signers will refuse.' },
  TIMEOUT: { label: 'TIMEOUT', tone: 'warn', note: 'Bank unresponsive — debits time out.' },
};

function SignerChip({ s }: { s: SignerHealth }) {
  const tone = s.revoked ? 'bad' : s.online ? 'ok' : 'muted';
  return (
    <div
      className={clsx(
        'flex flex-col gap-1.5 rounded-lg border px-3 py-2.5',
        s.revoked ? 'border-bad/40 bg-bad/8' : s.online ? 'border-edge bg-white/4' : 'border-edge bg-white/2 opacity-70',
      )}
    >
      <div className="flex items-center gap-2">
        <Dot tone={tone} pulse={s.online && !s.revoked} />
        <span className="text-[13px] font-semibold text-ink">{s.name}</span>
        <span className="ml-auto tnum text-[10px] text-ink-faint">#{s.identifier}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Chip tone={s.online ? 'ok' : 'bad'}>{s.online ? 'online' : 'offline'}</Chip>
        <Chip tone={s.sharePresent ? 'info' : 'bad'}>{s.sharePresent ? 'share held' : 'share missing'}</Chip>
        {s.revoked && <Chip tone="bad">REVOKED</Chip>}
        {s.refuse && <Chip tone="warn">refusing</Chip>}
      </div>
      <span className="tnum text-[11px] text-ink-faint">last partial: {ago(s.lastPartialAt)}</span>
    </div>
  );
}

export function WallsPanel({ snap }: { snap: Snapshot }) {
  const { bank, consortium } = snap;
  const mode = MODE_INFO[bank.mode] ?? MODE_INFO.CONFIRM;
  const wall1Blocked = !bank.up || bank.mode !== 'CONFIRM';
  const wall2Blocked = !consortium.quorumReachable;
  const onlineCount = consortium.signers.filter((s) => s.online && !s.revoked).length;

  return (
    <section>
      <PanelTitle
        title="Two Walls Status"
        sub="Two independent checks guard every token. A wall that would block generation lights up red."
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Wall 1 — Bank */}
        <Card alarmed={wall1Blocked} className="p-5">
          <div className="mb-4 flex items-center gap-3">
            <span className={clsx('flex h-10 w-10 items-center justify-center rounded-lg border', wall1Blocked ? 'border-bad/40 bg-bad/10 text-bad-soft' : 'border-ok/30 bg-ok/10 text-ok-soft')}>
              <BankIcon className="h-5 w-5" />
            </span>
            <div>
              <h3 className="font-semibold text-ink">Wall 1 — Bank confirmed debit</h3>
              <p className="text-[12px] text-ink-muted">No signed debit, no token. The money must move first.</p>
            </div>
            <Chip tone={wall1Blocked ? 'bad' : 'ok'} className="ml-auto">
              <Dot tone={wall1Blocked ? 'bad' : 'ok'} pulse />
              {wall1Blocked ? 'WOULD BLOCK' : 'PASSING'}
            </Chip>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Service" value={bank.up ? 'UP' : 'DOWN'} tone={bank.up ? 'ok' : 'bad'} />
            <Stat label="Mode" value={mode.label} tone={mode.tone} />
            <Stat label="Confirm rate" value={`${bank.confirmRatePct}%`} tone={bank.confirmRatePct >= 90 ? 'ok' : bank.confirmRatePct >= 50 ? 'warn' : 'bad'} />
            <Stat label="Last confirmation" value={ago(bank.lastConfirmationAt)} tone="muted" />
          </div>
          <p className={clsx('mt-3 text-[12px]', wall1Blocked ? 'text-bad-soft' : 'text-ink-faint')}>{mode.note}</p>
        </Card>

        {/* Wall 2 — Consortium */}
        <Card alarmed={wall2Blocked} className="p-5">
          <div className="mb-4 flex items-center gap-3">
            <span className={clsx('flex h-10 w-10 items-center justify-center rounded-lg border', wall2Blocked ? 'border-bad/40 bg-bad/10 text-bad-soft' : 'border-ok/30 bg-ok/10 text-ok-soft')}>
              <ShieldIcon className="h-5 w-5" />
            </span>
            <div>
              <h3 className="font-semibold text-ink">Wall 2 — Consortium quorum</h3>
              <p className="text-[12px] text-ink-muted">
                FROST {consortium.threshold.t}-of-{consortium.threshold.n} threshold signature. No single insider can sign.
              </p>
            </div>
            <Chip tone={wall2Blocked ? 'bad' : 'ok'} className="ml-auto">
              <Dot tone={wall2Blocked ? 'bad' : 'ok'} pulse />
              {wall2Blocked ? 'QUORUM LOST' : 'QUORUM READY'}
            </Chip>
          </div>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Threshold" value={`${consortium.threshold.t} of ${consortium.threshold.n}`} tone="info" />
            <Stat label="Signers available" value={`${onlineCount} / ${consortium.signers.length}`} tone={onlineCount >= consortium.threshold.t ? 'ok' : 'bad'} />
            <Stat label="Group key" value={truncMiddle(consortium.groupPublicKey, 6, 4) || '—'} tone="muted" mono />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {consortium.signers.map((s) => (
              <SignerChip key={s.signerId} s={s} />
            ))}
          </div>
          {wall2Blocked && (
            <p className="mt-3 text-[12px] text-bad-soft">
              Fewer than {consortium.threshold.t} signers reachable — token generation is impossible until quorum returns.
            </p>
          )}
        </Card>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
  mono = false,
}: {
  label: string;
  value: string;
  tone: 'ok' | 'bad' | 'warn' | 'info' | 'muted';
  mono?: boolean;
}) {
  const color =
    tone === 'ok' ? 'text-ok-soft' : tone === 'bad' ? 'text-bad-soft' : tone === 'warn' ? 'text-warn-soft' : tone === 'info' ? 'text-info' : 'text-ink';
  return (
    <div className="rounded-lg border border-edge bg-white/4 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-ink-faint">{label}</div>
      <div className={clsx('tnum mt-0.5 text-[15px] font-semibold', color, mono && 'font-mono text-[13px]')}>{value}</div>
    </div>
  );
}
