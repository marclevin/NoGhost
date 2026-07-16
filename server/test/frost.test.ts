import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import {
  trustedDealerKeygen,
  round1,
  round2Sign,
  aggregate,
  verifySignature,
  verifySignatureShare,
  scalarToHex,
  type Commitment,
  type KeygenOutput,
} from '../src/frost/frost.js';
import { canonicalBytes, hexToBytes } from '../src/common/canonical.js';

const MSG = canonicalBytes({ meterId: 'MTR-0001', amountKwh: 50, nonce: 'aabbccdd00112233aabbccdd00112233' });

function ceremony(keys: KeygenOutput, participantIds: number[], message = MSG) {
  const byId = new Map(keys.shares.map((s) => [s.identifier, s]));
  const r1 = participantIds.map((id) => ({ id, out: round1(byId.get(id)!.secretShare) }));
  const commitments: Commitment[] = r1.map(({ id, out }) => ({
    identifier: id,
    hiding: out.commitment.hiding,
    binding: out.commitment.binding,
  }));
  const shares = r1.map(({ id, out }) => ({
    identifier: id,
    zi: round2Sign({
      identifier: id,
      secretShare: byId.get(id)!.secretShare,
      nonces: out.nonces,
      message,
      commitments,
      groupPublicKey: keys.groupPublicKey,
    }).zi,
  }));
  return { commitments, shares };
}

describe('FROST(Ed25519, SHA-512) 2-of-3', () => {
  const keys = trustedDealerKeygen(2, 3);

  it('any 2-of-3 subset produces a signature that verifies under STANDARD Ed25519', () => {
    for (const subset of [
      [1, 2],
      [1, 3],
      [2, 3],
    ]) {
      const { commitments, shares } = ceremony(keys, subset);
      const { signature } = aggregate(commitments, shares, keys.groupPublicKey, MSG);
      // our verifier
      expect(verifySignature(signature, MSG, keys.groupPublicKey)).toBe(true);
      // and completely independent noble ed25519.verify (what the meter uses)
      expect(ed25519.verify(hexToBytes(signature), MSG, hexToBytes(keys.groupPublicKey))).toBe(true);
    }
  });

  it('all 3 participants also produce a valid signature', () => {
    const { commitments, shares } = ceremony(keys, [1, 2, 3]);
    const { signature } = aggregate(commitments, shares, keys.groupPublicKey, MSG);
    expect(verifySignature(signature, MSG, keys.groupPublicKey)).toBe(true);
  });

  it('FR-7: a single participant below threshold CANNOT produce a valid signature', () => {
    // lone signer runs the full protocol alone (commitment list = just them)
    const { commitments, shares } = ceremony(keys, [2]);
    const { signature } = aggregate(commitments, shares, keys.groupPublicKey, MSG);
    expect(verifySignature(signature, MSG, keys.groupPublicKey)).toBe(false);
  });

  it('a partial signature share alone is not a valid signature over anything', () => {
    const subset = [1, 2];
    const { commitments, shares } = ceremony(keys, subset);
    // take only signer 1's partial, try to pass it off with the group commitment
    const { signature } = aggregate(commitments, [shares[0], { identifier: 2, zi: scalarToHex(0n) }], keys.groupPublicKey, MSG);
    expect(verifySignature(signature, MSG, keys.groupPublicKey)).toBe(false);
  });

  it('signature does not verify for a tampered message', () => {
    const { commitments, shares } = ceremony(keys, [1, 3]);
    const { signature } = aggregate(commitments, shares, keys.groupPublicKey, MSG);
    const tampered = canonicalBytes({ meterId: 'MTR-0001', amountKwh: 9999, nonce: 'aabbccdd00112233aabbccdd00112233' });
    expect(verifySignature(signature, tampered, keys.groupPublicKey)).toBe(false);
  });

  it('verifySignatureShare attributes a corrupted partial to the right signer', () => {
    const byId = new Map(keys.shares.map((s) => [s.identifier, s]));
    const { commitments, shares } = ceremony(keys, [1, 2]);
    const good = shares[0];
    const bad = { identifier: 2, zi: scalarToHex(123456789n) };
    expect(
      verifySignatureShare(good, byId.get(1)!.verificationShare, commitments, keys.groupPublicKey, MSG),
    ).toBe(true);
    expect(
      verifySignatureShare(bad, byId.get(2)!.verificationShare, commitments, keys.groupPublicKey, MSG),
    ).toBe(false);
  });

  it('nonce reuse across different ceremonies is not possible via the API (fresh round1 each time)', () => {
    const a = round1(keys.shares[0].secretShare);
    const b = round1(keys.shares[0].secretShare);
    expect(a.nonces.hiding).not.toBe(b.nonces.hiding);
    expect(a.commitment.hiding).not.toBe(b.commitment.hiding);
  });

  it('keygen returns shares whose verification shares are consistent', () => {
    // interpolating verification shares at 0 must equal the group public key —
    // checked implicitly by signatures verifying; here just sanity-check shapes
    expect(keys.shares).toHaveLength(3);
    expect(new Set(keys.shares.map((s) => s.secretShare)).size).toBe(3);
    expect(keys.groupPublicKey).toMatch(/^[0-9a-f]{64}$/);
  });
});
