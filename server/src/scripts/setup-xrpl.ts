/**
 * One-time on-chain consortium ceremony (testnet).
 *
 * Creates and funds four XRPL accounts:
 *   - one per consortium member (utility / city-a / city-b) — each posts its own
 *     on-chain approvals and contributes one signature to the multisigned receipt
 *   - one "authority" account whose transactions ARE the receipts; it carries a
 *     2-of-3 SignerList over the three members, and its master key is DISABLED so
 *     no single party (not even the coordinator) can emit a receipt alone.
 *
 * Also mints a shared consortium symmetric key (AES-256-GCM) used to encrypt the
 * on-chain request payload so the public ledger carries ciphertext, not PII.
 *
 * Self-verifies the 2-of-3 multisign BEFORE disabling the master key, and again
 * after, so we never brick the account.
 *
 * Writes to server/keys/ (gitignored):
 *   xrpl-consortium.json     — authority + member ADDRESSES + quorum (public)
 *   xrpl-member-<id>.json    — each member's XRPL secret (PRIVATE)
 *   consortium-enc.json      — shared request-encryption key (PRIVATE)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Client, Wallet, multisign, type SubmittableTransaction } from 'xrpl';
import { decodeAccountID } from 'ripple-address-codec';
import { KEYS_DIR, SIGNERS, XRPL_WSS, XRPL_MULTISIGN_QUORUM, CONSORTIUM_MANIFEST, CONSORTIUM_ENC_KEY_FILE, xrplMemberKeyFile, XRPL_EXPLORER_ACCOUNT } from '../common/config.js';

const log = (msg: string) => console.log(`[setup-xrpl] ${msg}`);

async function fundNew(client: Client, label: string): Promise<Wallet> {
  // testnet faucet: generates + funds. Retry a couple of times on flakiness.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { wallet, balance } = await client.fundWallet();
      log(`funded ${label}: ${wallet.address} (${balance} XRP)`);
      return wallet;
    } catch (e) {
      lastErr = e;
      log(`fund ${label} attempt ${attempt} failed: ${String((e as Error)?.message ?? e)} — retrying`);
    }
  }
  throw new Error(`could not fund ${label}: ${String(lastErr)}`);
}

async function submit(client: Client, wallet: Wallet, tx: SubmittableTransaction, what: string): Promise<string> {
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const res = await client.submitAndWait(signed.tx_blob);
  const meta = res.result.meta;
  const code = typeof meta === 'object' && meta && 'TransactionResult' in meta ? (meta as { TransactionResult: string }).TransactionResult : '?';
  if (code !== 'tesSUCCESS') throw new Error(`${what}: ${code}`);
  log(`${what}: tesSUCCESS (${res.result.hash})`);
  return res.result.hash;
}

/** Multisign a transaction on the authority account with `quorum` member wallets. */
async function submitMultisign(client: Client, authority: string, tx: SubmittableTransaction, signers: Wallet[], what: string): Promise<string> {
  const prepared = await client.autofill(tx, signers.length);
  (prepared as { SigningPubKey?: string }).SigningPubKey = '';
  const blobs = signers.map((w) => w.sign(prepared, true).tx_blob);
  const combined = multisign(blobs);
  const res = await client.submitAndWait(combined);
  const meta = res.result.meta;
  const code = typeof meta === 'object' && meta && 'TransactionResult' in meta ? (meta as { TransactionResult: string }).TransactionResult : '?';
  if (code !== 'tesSUCCESS') throw new Error(`${what}: ${code}`);
  log(`${what}: tesSUCCESS (${res.result.hash})`);
  return res.result.hash;
}

async function main() {
  mkdirSync(KEYS_DIR, { recursive: true });
  const client = new Client(XRPL_WSS);
  client.on('error', () => {});
  await client.connect();
  log(`connected to ${XRPL_WSS}`);

  // 1. fund the four accounts (members first, then authority)
  const members: { signerId: (typeof SIGNERS)[number]['signerId']; wallet: Wallet }[] = [];
  for (const s of SIGNERS) members.push({ signerId: s.signerId, wallet: await fundNew(client, s.signerId) });
  const authority = await fundNew(client, 'authority');

  // 2. SignerList: 2-of-3 over the members (entries MUST be sorted by account id)
  const entries = members
    .map((m) => ({ account: m.wallet.address }))
    .sort((a, b) => Buffer.compare(decodeAccountID(a.account), decodeAccountID(b.account)))
    .map((m) => ({ SignerEntry: { Account: m.account, SignerWeight: 1 } }));
  await submit(
    client,
    authority,
    { TransactionType: 'SignerListSet', Account: authority.address, SignerQuorum: XRPL_MULTISIGN_QUORUM, SignerEntries: entries },
    'SignerListSet (2-of-3)',
  );

  // 3. verify multisign WORKS before we disable the master key (safety)
  const quorumSigners = members.slice(0, XRPL_MULTISIGN_QUORUM).map((m) => m.wallet);
  await submitMultisign(
    client,
    authority.address,
    { TransactionType: 'AccountSet', Account: authority.address },
    quorumSigners,
    'multisign self-test (pre-disable)',
  );

  // 4. disable the authority master key → receipts now REQUIRE 2-of-3 member sigs
  await submit(client, authority, { TransactionType: 'AccountSet', Account: authority.address, SetFlag: 4 /* asfDisableMaster */ }, 'disable master key');

  // 5. verify multisign STILL works after disabling the master key
  await submitMultisign(
    client,
    authority.address,
    { TransactionType: 'AccountSet', Account: authority.address },
    quorumSigners,
    'multisign self-test (post-disable)',
  );

  // 6. write key material
  const encKey = randomBytes(32).toString('hex');
  writeFileSync(CONSORTIUM_ENC_KEY_FILE, JSON.stringify({ alg: 'aes-256-gcm', key: encKey, createdAt: new Date().toISOString() }, null, 2));
  for (const m of members) {
    writeFileSync(xrplMemberKeyFile(m.signerId), JSON.stringify({ signerId: m.signerId, address: m.wallet.address, secret: m.wallet.seed }, null, 2));
  }
  writeFileSync(
    CONSORTIUM_MANIFEST,
    JSON.stringify(
      {
        network: XRPL_WSS,
        authority: authority.address,
        quorum: XRPL_MULTISIGN_QUORUM,
        masterKeyDisabled: true,
        members: Object.fromEntries(members.map((m) => [m.signerId, m.wallet.address])),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  log('');
  log('consortium ready:');
  log(`  authority (receipts, master-key DISABLED): ${authority.address}`);
  log(`     ${XRPL_EXPLORER_ACCOUNT(authority.address)}`);
  for (const m of members) log(`  ${m.signerId}: ${m.wallet.address}`);
  log(`  quorum: ${XRPL_MULTISIGN_QUORUM}-of-${members.length}`);
  await client.disconnect();
}

main().catch((e) => {
  console.error('[setup-xrpl] FAILED:', e);
  process.exit(1);
});
