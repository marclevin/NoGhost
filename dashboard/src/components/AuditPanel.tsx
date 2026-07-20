/** Panel E — Audit Trail: chronological on-chain authorisation records, each linking out to XRPL (FR-D5). */
import type { LedgerRecord, Snapshot } from '../types';
import { Card, Chip, EmptyState, ExplorerLink, Hash, NONE, PanelTitle, fmtDateTime } from './ui';

function ledgerRecords(snap: Snapshot): LedgerRecord[] {
  return snap.requests.filter((r) => r.ledger).map((r) => r.ledger as LedgerRecord);
}

export function AuditPanel({ snap }: { snap: Snapshot }) {
  const records = ledgerRecords(snap);
  return (
    <section>
      <PanelTitle
        title="Audit Trail: immutable witness"
        sub="Every authorisation is anchored on the XRPL testnet: hashes only (POPIA-safe), independently verifiable off this dashboard."
        right={
          <span className="tnum text-[12px] text-ink-faint">
            {records.length} on-chain record{records.length === 1 ? '' : 's'}
          </span>
        }
      />
      <Card className="overflow-hidden">
        {records.length === 0 ? (
          <div className="p-5">
            <EmptyState>No on-chain records yet. Deliver a token to write the first one.</EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-ink-faint">
                  <th className="px-4 py-2.5 font-medium">Timestamp</th>
                  <th className="px-4 py-2.5 font-medium">Request hash</th>
                  <th className="px-4 py-2.5 font-medium">Debit-ref hash</th>
                  <th className="px-4 py-2.5 font-medium">Token hash</th>
                  <th className="px-4 py-2.5 font-medium">Signer set</th>
                  <th className="px-4 py-2.5 font-medium">Ledger idx</th>
                  <th className="px-4 py-2.5 font-medium">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {records.map((rec) => (
                  <tr key={rec.txHash} className="border-t border-edge text-[12px] hover:bg-white/3">
                    <td className="tnum whitespace-nowrap px-4 py-2.5 text-ink-muted">{fmtDateTime(rec.timestamp)}</td>
                    <td className="px-4 py-2.5">
                      <Hash value={rec.requestHash} />
                    </td>
                    <td className="px-4 py-2.5">
                      <Hash value={rec.debitRefHash} />
                    </td>
                    <td className="px-4 py-2.5">
                      <Hash value={rec.tokenHash} />
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="flex flex-wrap gap-1">
                        {/* the FROST quorum itself is an off-chain artefact */}
                        {rec.signerSet.map((s) => (
                          <Chip key={s} tone="local">
                            {s}
                          </Chip>
                        ))}
                        {rec.multisign && <Chip tone="ledger">2-of-3 multisign</Chip>}
                      </span>
                    </td>
                    <td className="tnum px-4 py-2.5 text-ink-muted">{rec.ledgerIndex ?? NONE}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span className="inline-flex items-center gap-1">
                        <Hash value={rec.txHash} head={8} tail={6} />
                        <ExplorerLink url={rec.explorerUrl} label="explorer" />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}
