/**
 * XRPL testnet smoke test: connect with the .env wallet, submit one AccountSet
 * transaction carrying a memo, print the validated tx hash + explorer link.
 */
import { Client, Wallet, convertStringToHex } from 'xrpl';
import { XRPL_WSS, XRP_WALLET_SECRET, XRPL_EXPLORER_TX } from '../common/config.js';

async function main() {
  if (!XRP_WALLET_SECRET) throw new Error('XRP_WALLET_SECRET missing from .env');
  const client = new Client(XRPL_WSS);
  await client.connect();
  const wallet = Wallet.fromSeed(XRP_WALLET_SECRET);
  console.log(`connected to ${XRPL_WSS} as ${wallet.address}`);

  const info = await client.request({ command: 'account_info', account: wallet.address, ledger_index: 'validated' });
  console.log(`balance: ${Number(info.result.account_data.Balance) / 1_000_000} XRP`);

  const tx = await client.autofill({
    TransactionType: 'AccountSet' as const,
    Account: wallet.address,
    Memos: [
      {
        Memo: {
          MemoType: convertStringToHex('twowalls/smoke'),
          MemoFormat: convertStringToHex('application/json'),
          MemoData: convertStringToHex(JSON.stringify({ v: 1, kind: 'smoke-test' })),
        },
      },
    ],
  });
  const signed = wallet.sign(tx);
  const result = await client.submitAndWait(signed.tx_blob);
  const meta = result.result.meta;
  const code = typeof meta === 'object' && meta !== null && 'TransactionResult' in meta ? meta.TransactionResult : '?';
  console.log(`result: ${code}, validated: ${result.result.validated}`);
  console.log(`tx: ${XRPL_EXPLORER_TX(result.result.hash)}`);
  await client.disconnect();
}

main().catch((e) => {
  console.error('SMOKE TEST FAILED:', e);
  process.exit(1);
});
