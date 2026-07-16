/** Panel D — Consortium governance: members, threshold policy, merchant registry, audit log. */
import { useState } from 'react';
import clsx from 'clsx';
import { api } from '../api';
import type { Snapshot, SignerId } from '../types';
import { Card, Chip, Dot, ExplorerLink, PanelTitle, ShieldIcon, Spinner, fmtDateTime, fmtZar, truncMiddle } from './ui';

function ActionButton({
  label,
  danger,
  onClick,
}: {
  label: string;
  danger: boolean;
  onClick: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void onClick().finally(() => setBusy(false));
      }}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-medium transition disabled:opacity-50',
        danger
          ? 'border-bad/40 bg-bad/10 text-bad-soft hover:bg-bad/20'
          : 'border-ok/40 bg-ok/10 text-ok-soft hover:bg-ok/20',
      )}
    >
      {busy && <Spinner className="h-3 w-3" />}
      {label}
    </button>
  );
}

export function GovernancePanel({ snap }: { snap: Snapshot }) {
  const chain = snap.consortium.chain;
  return (
    <section>
      <PanelTitle
        title="Consortium Governance"
        sub="Membership, threshold policy, merchant vetting — every action logged and attributable."
        right={
          <Chip tone="info" className="text-[12px]">
            Threshold policy: {snap.consortium.threshold.t}-of-{snap.consortium.threshold.n} FROST
          </Chip>
        }
      />

      {/* On-chain consortium */}
      {chain && (
        <Card className="mb-4 border-ledger/30 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldIcon className="h-4 w-4 text-ledger" />
            <h3 className="text-[13px] font-semibold text-ink">On-chain consortium</h3>
            <Chip tone="ledger">{chain.quorum}-of-{snap.consortium.threshold.n} multisign</Chip>
            {chain.masterKeyDisabled && <Chip tone="ok">master key DISABLED</Chip>}
          </div>
          <p className="mt-1 text-[12px] text-ink-muted">
            Each member is its own on-chain account; receipts require {chain.quorum}-of-{snap.consortium.threshold.n} — no smart contract.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-ledger/20 bg-ledger/6 px-3 py-2 text-[12px]">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ledger">Authority account</span>
            <code className="tnum font-mono text-ink" title={chain.authority}>
              {truncMiddle(chain.authority, 8, 6)}
            </code>
            <ExplorerLink url={chain.authorityExplorerUrl} label="explorer" />
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {snap.consortium.signers.map((s) => {
              const m = chain.members[s.signerId];
              if (!m) return null;
              return (
                <div key={s.signerId} className="rounded-lg border border-edge bg-white/4 px-3 py-2">
                  <div className="text-[13px] font-semibold text-ink">{s.name}</div>
                  <div className="text-[11px] text-ink-faint">{s.org}</div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <code className="tnum font-mono text-[11px] text-ledger" title={m.address}>
                      {truncMiddle(m.address, 6, 4)}
                    </code>
                    <ExplorerLink url={m.explorerUrl} label="explorer" />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Members */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {snap.members.map((m) => {
          const revoked = m.status === 'REVOKED';
          return (
            <Card key={m.signerId} className={clsx('p-4', revoked && 'border-bad/40')}>
              <div className="flex items-center gap-2">
                <Dot tone={revoked ? 'bad' : 'ok'} pulse={!revoked} />
                <span className="font-semibold text-ink">{m.name}</span>
                <Chip tone={revoked ? 'bad' : 'ok'} className="ml-auto">
                  {m.status}
                </Chip>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-ink-muted">
                <span>Organisation</span>
                <span className="text-right font-medium text-ink">{m.org}</span>
                <span>FROST identifier</span>
                <span className="tnum text-right font-medium text-ink">#{m.identifier}</span>
                <span>Bond posture</span>
                <span className="text-right font-medium text-warn-soft">
                  {m.bond.posture} · {fmtZar(m.bond.amountZar)}
                </span>
              </div>
              <p className="mt-2 rounded-md border border-edge bg-white/3 px-2.5 py-1.5 text-[11px] leading-snug text-ink-faint">
                {m.bond.note}
              </p>
              <div className="mt-3 flex justify-end">
                <ActionButton
                  label={revoked ? 'Reinstate member' : 'Revoke member'}
                  danger={!revoked}
                  onClick={() => api.memberAction(m.signerId as SignerId, revoked ? 'reinstate' : 'revoke')}
                />
              </div>
            </Card>
          );
        })}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Merchant registry */}
        <Card className="overflow-hidden">
          <div className="border-b border-edge px-5 py-3">
            <h3 className="text-[13px] font-semibold text-ink">Merchant registry</h3>
            <p className="text-[11px] text-ink-faint">only vetted, non-revoked merchants pass the policy gate</p>
          </div>
          <table className="w-full text-left">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-ink-faint">
                <th className="px-4 py-2 font-medium">ID</th>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {snap.merchants.map((mc) => (
                <tr key={mc.merchantId} className="border-t border-edge text-[13px]">
                  <td className="tnum px-4 py-2.5 font-mono text-[12px] text-ink-muted">{mc.merchantId}</td>
                  <td className="px-4 py-2.5 font-medium text-ink">{mc.name}</td>
                  <td className="px-4 py-2.5">
                    <span className="flex flex-wrap gap-1.5">
                      <Chip tone={mc.vetted ? 'info' : 'warn'}>{mc.vetted ? 'vetted' : 'unvetted'}</Chip>
                      {mc.revoked && <Chip tone="bad">REVOKED</Chip>}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <ActionButton
                      label={mc.revoked ? 'Reinstate' : 'Revoke'}
                      danger={!mc.revoked}
                      onClick={() => api.merchantAction(mc.merchantId, mc.revoked ? 'reinstate' : 'revoke')}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {/* Governance log */}
        <Card className="overflow-hidden">
          <div className="border-b border-edge px-5 py-3">
            <h3 className="text-[13px] font-semibold text-ink">Governance audit log</h3>
            <p className="text-[11px] text-ink-faint">membership + registry changes, newest first</p>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {snap.governanceLog.length === 0 && (
              <p className="px-5 py-8 text-center text-[12px] text-ink-faint">No governance actions recorded.</p>
            )}
            <ul className="divide-y divide-edge">
              {snap.governanceLog.map((e) => (
                <li key={e.id} className="flex items-baseline gap-3 px-5 py-2.5 text-[12px]">
                  <span className="tnum shrink-0 text-ink-faint">{fmtDateTime(e.at)}</span>
                  <span
                    className={clsx(
                      'shrink-0 font-mono text-[11px] font-semibold',
                      e.action.includes('REVOKED') ? 'text-bad-soft' : e.action.includes('REINSTATED') ? 'text-ok-soft' : 'text-info',
                    )}
                  >
                    {e.action}
                  </span>
                  <span className="font-medium text-ink">{e.subject}</span>
                  <span className="ml-auto truncate text-right text-ink-faint" title={e.detail}>
                    {e.detail ?? ''} <span className="text-ink-faint/70">by {e.actor}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>
    </section>
  );
}
