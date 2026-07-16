/**
 * Signer-side independent verification (Wall 2, FR-8) — CONTRACTS.md §2,
 * round-2 checks 3–6. Pure functions so the security-critical logic is
 * unit-testable without a live server.
 *
 * The signer NEVER trusts the coordinator: it verifies the bank attestation
 * against its own PINNED bank public key (provisioned out-of-band at boot),
 * re-prices the request itself, and re-derives the message bytes.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { canonicalBytes, bytesToHex, hexToBytes } from '../common/canonical.js';
import { CURRENCY, priceZar } from '../common/config.js';
import { buildTokenPayload } from '../common/token.js';
import type { DebitConfirmation, GenerationRequest, Round2Request } from '../common/types.js';

export interface CheckFailure {
  status: number;
  body: { error: string; detail?: string };
}

/**
 * Check 3 — the bank signature must verify with the pinned bank public key over
 * canonicalBytes({debitRef, requestId, meterId, amountKwh, amount, currency, confirmedAt}).
 * The payload is rebuilt field-by-field so extra keys cannot influence it. meterId and
 * amountKwh are inside the signed payload, so once this passes they are bank-attested.
 */
export function verifyBankSignature(debit: DebitConfirmation, bankPublicKeyHex: string): boolean {
  try {
    const payload = {
      debitRef: debit.debitRef,
      requestId: debit.requestId,
      meterId: debit.meterId,
      amountKwh: debit.amountKwh,
      amount: debit.amount,
      currency: debit.currency,
      confirmedAt: debit.confirmedAt,
    };
    return ed25519.verify(hexToBytes(debit.bankSignature), canonicalBytes(payload), hexToBytes(bankPublicKeyHex));
  } catch {
    return false; // malformed hex / bad point / missing fields ⇒ not verified
  }
}

/**
 * Wall-1 debit validation (checks 3–4): the bank attestation verifies with the
 * PINNED key, and the debit is FOR this request at the signer's own pricing.
 * meterId + amountKwh are inside the signed payload (check 3), so matching them
 * binds the request's economics to what the bank actually witnessed — not to
 * fields the (untrusted) coordinator merely asserts. Used both at on-chain
 * approval time (no token yet) and inside round-2.
 */
export function validateDebitForRequest(
  request: GenerationRequest,
  debit: DebitConfirmation,
  bankPublicKeyHex: string,
): CheckFailure | null {
  // 3. Wall 1: bank attestation verifies with the PINNED key (FR-8).
  if (!verifyBankSignature(debit, bankPublicKeyHex)) {
    return {
      status: 401,
      body: { error: 'WALL_1_UNVERIFIED', detail: 'bank signature failed verification against the pinned bank public key' },
    };
  }

  // 4. Debit must be FOR this request: same requestId, same target meter, same
  //    units, at the signer's OWN pricing, in ZAR.
  if (
    debit.requestId !== request.requestId ||
    debit.meterId !== request.meterId ||
    debit.amountKwh !== request.amountKwh ||
    debit.amount !== priceZar(request.amountKwh) ||
    debit.currency !== CURRENCY
  ) {
    return {
      status: 401,
      body: {
        error: 'WALL_1_MISMATCH',
        detail:
          `debit {requestId: ${debit.requestId}, meterId: ${debit.meterId}, amountKwh: ${debit.amountKwh}, ` +
          `amount: ${debit.amount} ${debit.currency}} does not match request ` +
          `{requestId: ${request.requestId}, meterId: ${request.meterId}, amountKwh: ${request.amountKwh}, ` +
          `expected: ${priceZar(request.amountKwh)} ${CURRENCY}}`,
      },
    };
  }
  return null;
}

/**
 * Round-2 checks 3–6, in contract order, with the contract's exact error
 * codes and HTTP statuses. Returns null when everything verifies.
 */
export function runWall1TokenChecks(req: Round2Request, bankPublicKeyHex: string): CheckFailure | null {
  // 3–4. Wall 1 debit validation.
  const debitFailure = validateDebitForRequest(req.request, req.debit, bankPublicKeyHex);
  if (debitFailure) return debitFailure;

  // 5. FR-20 at Wall 2 — the token must be EXACTLY the one payload this debit
  //    authorises: buildTokenPayload(debit). This ties meterId/amountKwh/debitRef
  //    and the deterministic nonce to the bank attestation, so a compromised
  //    coordinator cannot obtain a signature over any other token (e.g. a fresh
  //    nonce to double-mint, or a different meterId to retarget) from this debit.
  const expected = buildTokenPayload(req.debit);
  if (
    req.tokenPayload.meterId !== expected.meterId ||
    req.tokenPayload.amountKwh !== expected.amountKwh ||
    req.tokenPayload.debitRef !== expected.debitRef ||
    req.tokenPayload.nonce !== expected.nonce
  ) {
    return {
      status: 400,
      body: {
        error: 'TOKEN_NOT_DEBIT_BOUND',
        detail: 'tokenPayload is not the unique token authorised by this debit (buildTokenPayload(debit))',
      },
    };
  }

  // 6. The message being signed must be exactly canonicalBytes(tokenPayload).
  if (req.messageHex !== bytesToHex(canonicalBytes(req.tokenPayload))) {
    return {
      status: 400,
      body: { error: 'MESSAGE_MISMATCH', detail: 'messageHex is not canonicalBytes(tokenPayload)' },
    };
  }

  return null;
}
