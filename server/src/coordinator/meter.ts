/**
 * Simulated prepaid meter (§3.1 step 5 — closes the loop, FRD §4.3).
 *
 * The meter knows exactly ONE thing: the consortium group public key. It runs
 * a standard Ed25519 verification of the token signature (the FROST aggregate
 * IS a standard Ed25519 signature) and rejects replayed nonces. It has no idea
 * FROST exists — which is the point.
 */
import { canonicalBytes } from '../common/canonical.js';
import { verifySignature } from '../frost/frost.js';
import type { Token, TokenPayload } from '../common/types.js';
import * as store from './store.js';

const usedNonces = new Set<string>();
const usedDebitRefs = new Set<string>(); // one dispense per debit (nonce is derived from debitRef, so this is belt-and-braces)

export type DeliveryResult = { ok: true } | { ok: false; reason: string };

/** Non-mutating validity check — signature + not-yet-redeemed. Run BEFORE the
 *  immutable ledger write so a token the meter would reject never leaves an
 *  orphan on-chain record behind. Credits nothing. */
export function verifyTokenForMeter(token: Token): DeliveryResult {
  if (usedNonces.has(token.nonce) || usedDebitRefs.has(token.debitRef)) {
    return { ok: false, reason: 'METER_REPLAY — a token for this debit was already redeemed' };
  }
  const payload: TokenPayload = {
    meterId: token.meterId,
    amountKwh: token.amountKwh,
    debitRef: token.debitRef,
    nonce: token.nonce,
  };
  if (!verifySignature(token.signature, canonicalBytes(payload), store.GROUP.groupPublicKey)) {
    return { ok: false, reason: 'METER_SIGNATURE_INVALID — token does not verify against the group public key' };
  }
  return { ok: true };
}

/** Verify then dispense — closes the loop (§4.3). The meter knows only the group
 *  public key; the FROST aggregate is a standard Ed25519 signature. */
export function deliverToken(token: Token): DeliveryResult {
  const check = verifyTokenForMeter(token);
  if (!check.ok) return check;
  usedNonces.add(token.nonce);
  usedDebitRefs.add(token.debitRef);
  store.creditMeter(token.meterId, token.amountKwh); // emits meter.updated
  return { ok: true };
}
