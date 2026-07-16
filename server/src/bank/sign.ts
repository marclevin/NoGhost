/**
 * Bank-side debit attestation signing (Wall 1).
 *
 * The bank signs `canonicalBytes(DebitSignedPayload)` with Ed25519 — key order
 * is irrelevant because canonicalBytes sorts keys. Kept pure so it can be
 * unit-tested without a live server.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { canonicalBytes, bytesToHex, hexToBytes } from '../common/canonical.js';
import type { DebitConfirmation, DebitSignedPayload } from '../common/types.js';

/** OMIT_SIGNATURE mode: a forged/absent attestation — 64 zero bytes as hex. */
export const ZERO_SIGNATURE = '0'.repeat(128);

/**
 * Extract EXACTLY the fields the bank signs. Built explicitly (not by object
 * spread) so extra keys can never sneak into the signed byte string.
 */
export function debitSignedPayload(d: Omit<DebitConfirmation, 'bankSignature'>): DebitSignedPayload {
  return {
    debitRef: d.debitRef,
    requestId: d.requestId,
    meterId: d.meterId,
    amountKwh: d.amountKwh,
    amount: d.amount,
    currency: d.currency,
    confirmedAt: d.confirmedAt,
  };
}

export function signDebitPayload(payload: DebitSignedPayload, secretKeyHex: string): string {
  return bytesToHex(ed25519.sign(canonicalBytes(debitSignedPayload(payload)), hexToBytes(secretKeyHex)));
}
