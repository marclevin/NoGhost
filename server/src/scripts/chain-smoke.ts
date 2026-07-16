/**
 * Smoke test for the on-chain consensus primitives (chain.ts) against testnet:
 * publish an encrypted request → read+decrypt it back → 2 members post on-chain
 * approvals → read approvals back → 2-of-3 multisign a receipt → verify.
 */
import { Wallet } from 'xrpl';
import { XRP_WALLET_SECRET, XRPL_EXPLORER_TX } from '../common/config.js';
import { hashValue } from '../common/canonical.js';
import {
  loadManifest,
  loadMemberWallet,
  publishRequest,
  readRequestTx,
  postApproval,
  readApprovals,
  prepareReceipt,
  signReceiptFragment,
  submitReceipt,
  disconnectChain,
} from '../common/chain.js';

async function main() {
  const manifest = loadManifest();
  console.log(`authority: ${manifest.authority} (quorum ${manifest.quorum})`);
  const publisher = Wallet.fromSeed(XRP_WALLET_SECRET);

  // a fake request+debit payload (what the coordinator would publish)
  const payload = {
    request: { requestId: 'SMOKE-1', meterId: 'MTR-1001', amountKwh: 15, merchantId: 'MER-001', timestamp: new Date().toISOString() },
    debit: { debitRef: 'DBT-smoke', amount: 37.5 },
  };
  const requestHash = hashValue(payload);

  console.log('\n[1] publish encrypted request on-chain...');
  const pub = await publishRequest(publisher, requestHash, payload);
  console.log(`    request tx: ${XRPL_EXPLORER_TX(pub.txHash)}`);

  console.log('[2] read it back from chain + decrypt...');
  const readBack = await readRequestTx<typeof payload>(pub.txHash);
  console.log(`    decrypted requestId=${readBack?.payload.request.requestId}, hash matches=${readBack?.requestHash === requestHash}`);
  if (!readBack || readBack.requestHash !== requestHash) throw new Error('read-back/decrypt/hash-check failed');

  console.log('[3] two members post on-chain approvals...');
  const a1 = await postApproval(loadMemberWallet('utility'), 'utility', requestHash, 'APPROVE');
  const a2 = await postApproval(loadMemberWallet('city-a'), 'city-a', requestHash, 'APPROVE');
  console.log(`    utility approval: ${XRPL_EXPLORER_TX(a1.txHash)}`);
  console.log(`    city-a approval:  ${XRPL_EXPLORER_TX(a2.txHash)}`);

  console.log('[4] read approvals back from chain...');
  const approvals = await readApprovals(requestHash);
  console.log(`    approvals found: ${approvals.map((a) => `${a.signerId}:${a.verdict}`).join(', ')}`);
  const approveCount = approvals.filter((a) => a.verdict === 'APPROVE').length;
  if (approveCount < manifest.quorum) throw new Error(`expected >= ${manifest.quorum} approvals, got ${approveCount}`);

  console.log('[5] 2-of-3 multisign a receipt...');
  const prepared = await prepareReceipt({
    requestHash,
    debitRefHash: hashValue('DBT-smoke'),
    tokenHash: hashValue({ token: 'smoke' }),
    signerSet: ['utility', 'city-a'],
    ts: new Date().toISOString(),
  });
  const frag1 = signReceiptFragment(loadMemberWallet('utility'), prepared);
  const frag2 = signReceiptFragment(loadMemberWallet('city-a'), prepared);
  const receipt = await submitReceipt([frag1, frag2]);
  console.log(`    receipt tx (2-of-3 multisign): ${receipt.explorerUrl}`);

  console.log('\nRESULT: PASS — request published + read + approved + multisigned receipt, all on-chain.');
  await disconnectChain();
}

main().catch(async (e) => {
  console.error('CHAIN SMOKE FAILED:', e);
  await disconnectChain();
  process.exit(1);
});
