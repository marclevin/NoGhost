/**
 * Token ⇄ debit binding — the single source of truth shared by the coordinator
 * (who builds the token payload) and every signer (who re-derives and verifies
 * it independently). Keeping this in ONE place is what makes "one debit, one
 * token" (FR-20) a property of Wall 2 rather than of the coordinator.
 *
 * The token payload for a debit is FULLY determined by the bank-signed debit:
 *   - meterId, amountKwh, debitRef come straight from the (signed) debit
 *   - nonce = deriveTokenNonce(debitRef)  (deterministic, not random)
 *
 * Consequences:
 *   - There is exactly ONE valid token message per debit. A compromised
 *     coordinator that reruns the ceremony with the same debit can only ever
 *     obtain a signature over this identical message — never a second, distinct
 *     redeemable token.
 *   - Any two tokens derived from one debit share the same nonce, so the meter's
 *     replay guard collapses a replay to a single dispensed token, with no
 *     coordinator involvement.
 */
import { sha256Hex } from './canonical.js';
import type { DebitConfirmation, TokenPayload } from './types.js';

/** Deterministic 16-byte (32 hex) token nonce bound to the debit. */
export function deriveTokenNonce(debitRef: string): string {
  return sha256Hex('twowalls/token-nonce/v1/' + debitRef).slice(0, 32);
}

/** The one canonical token payload authorised by a given bank-signed debit. */
export function buildTokenPayload(debit: DebitConfirmation): TokenPayload {
  return {
    meterId: debit.meterId,
    amountKwh: debit.amountKwh,
    debitRef: debit.debitRef,
    nonce: deriveTokenNonce(debit.debitRef),
  };
}
