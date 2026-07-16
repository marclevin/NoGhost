/**
 * One-time key ceremony for the PoC (trusted dealer — FRD §9 simplification).
 *
 * Produces, under server/keys/ (gitignored):
 *   group.json            — group public key + verification shares (public)
 *   signer-<id>.json      — each consortium member's PRIVATE key share
 *   bank.json             — the mock bank's PRIVATE Ed25519 signing key
 *   bank.pub.json         — the bank's public key (pinned by each signer, FR-8)
 *
 * In production each share would be generated via DKG inside each
 * institution's HSM; here the dealer secret is discarded immediately.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { trustedDealerKeygen } from '../frost/frost.js';
import { KEYS_DIR, SIGNERS, THRESHOLD } from '../common/config.js';
import { bytesToHex } from '../common/canonical.js';

mkdirSync(KEYS_DIR, { recursive: true });

const keys = trustedDealerKeygen(THRESHOLD.t, THRESHOLD.n);

writeFileSync(
  resolve(KEYS_DIR, 'group.json'),
  JSON.stringify(
    {
      groupPublicKey: keys.groupPublicKey,
      threshold: keys.threshold,
      total: keys.total,
      verificationShares: Object.fromEntries(keys.shares.map((s) => [s.identifier, s.verificationShare])),
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

for (const signer of SIGNERS) {
  const share = keys.shares.find((s) => s.identifier === signer.identifier)!;
  writeFileSync(
    resolve(KEYS_DIR, `signer-${signer.signerId}.json`),
    JSON.stringify(
      {
        signerId: signer.signerId,
        identifier: share.identifier,
        secretShare: share.secretShare,
        verificationShare: share.verificationShare,
        groupPublicKey: keys.groupPublicKey,
      },
      null,
      2,
    ),
  );
}

const bankSecret = randomBytes(32);
const bankPublic = ed25519.getPublicKey(bankSecret);
writeFileSync(resolve(KEYS_DIR, 'bank.json'), JSON.stringify({ secretKey: bytesToHex(bankSecret) }, null, 2));
writeFileSync(resolve(KEYS_DIR, 'bank.pub.json'), JSON.stringify({ publicKey: bytesToHex(bankPublic) }, null, 2));

console.log('Key ceremony complete (trusted dealer, PoC).');
console.log(`  group public key : ${keys.groupPublicKey}`);
console.log(`  threshold        : ${keys.threshold}-of-${keys.total}`);
console.log(`  shares written   : ${SIGNERS.map((s) => s.signerId).join(', ')}`);
console.log(`  bank keypair     : bank.json / bank.pub.json`);
console.log(`  keys dir         : ${KEYS_DIR}`);
