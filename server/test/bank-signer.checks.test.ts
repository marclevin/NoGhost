/**
 * Pure-logic tests for the bank's debit attestation signing and the signer's
 * independent round-2 verification (CONTRACTS.md §1/§2) — no live servers.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, canonicalBytes } from '../src/common/canonical.js';
import { CURRENCY, priceZar } from '../src/common/config.js';
import { buildTokenPayload, deriveTokenNonce } from '../src/common/token.js';
import { signDebitPayload, debitSignedPayload, ZERO_SIGNATURE } from '../src/bank/sign.js';
import { verifyBankSignature, runWall1TokenChecks } from '../src/signer/verify.js';
import type { DebitConfirmation, GenerationRequest, Round2Request, TokenPayload } from '../src/common/types.js';

// ephemeral bank keypair — the test never touches server/keys/
const secretKey = bytesToHex(randomBytes(32));
const publicKey = bytesToHex(ed25519.getPublicKey(secretKey));

function makeFixture(amountKwh = 50, meterId = 'MTR-1001') {
  const request: GenerationRequest = {
    requestId: 'REQ-test-1',
    meterId,
    amountKwh,
    merchantId: 'MER-001',
    timestamp: new Date().toISOString(),
  };
  const payload = debitSignedPayload({
    debitRef: 'DBT-' + bytesToHex(randomBytes(6)),
    requestId: request.requestId,
    meterId,
    amountKwh,
    amount: priceZar(amountKwh),
    currency: CURRENCY,
    confirmedAt: new Date().toISOString(),
  });
  const debit: DebitConfirmation = { ...payload, bankSignature: signDebitPayload(payload, secretKey) };
  // the token is the ONE payload this debit authorises
  const tokenPayload: TokenPayload = buildTokenPayload(debit);
  const round2: Round2Request = {
    sessionId: request.requestId,
    messageHex: bytesToHex(canonicalBytes(tokenPayload)),
    tokenPayload,
    request,
    debit,
    commitments: [],
  };
  return { request, debit, tokenPayload, round2 };
}

describe('bank debit signing ↔ signer verification round-trip', () => {
  it('a bank-signed debit verifies against the pinned public key', () => {
    const { debit } = makeFixture();
    expect(verifyBankSignature(debit, publicKey)).toBe(true);
  });

  it('signing is over canonical (sorted-key) bytes — field order is irrelevant', () => {
    const { debit } = makeFixture();
    // rebuild the same debit with keys in a scrambled order (all signed fields present)
    const scrambled = JSON.parse(
      JSON.stringify({
        confirmedAt: debit.confirmedAt,
        bankSignature: debit.bankSignature,
        currency: debit.currency,
        debitRef: debit.debitRef,
        amountKwh: debit.amountKwh,
        meterId: debit.meterId,
        amount: debit.amount,
        requestId: debit.requestId,
      }),
    ) as DebitConfirmation;
    expect(verifyBankSignature(scrambled, publicKey)).toBe(true);
  });

  it('tampering with the amount breaks the signature', () => {
    const { debit } = makeFixture();
    expect(verifyBankSignature({ ...debit, amount: debit.amount + 1 }, publicKey)).toBe(false);
  });

  it('tampering with the bank-attested meterId breaks the signature', () => {
    const { debit } = makeFixture();
    expect(verifyBankSignature({ ...debit, meterId: 'MTR-9999' }, publicKey)).toBe(false);
  });

  it('tampering with the bank-attested amountKwh breaks the signature', () => {
    const { debit } = makeFixture();
    expect(verifyBankSignature({ ...debit, amountKwh: debit.amountKwh + 1 }, publicKey)).toBe(false);
  });

  it('the OMIT_SIGNATURE zero signature (128 hex zeros) never verifies', () => {
    const { debit } = makeFixture();
    expect(ZERO_SIGNATURE).toHaveLength(128);
    expect(verifyBankSignature({ ...debit, bankSignature: ZERO_SIGNATURE }, publicKey)).toBe(false);
  });

  it('garbage / malformed signatures are rejected without throwing', () => {
    const { debit } = makeFixture();
    expect(verifyBankSignature({ ...debit, bankSignature: 'zz' }, publicKey)).toBe(false);
    expect(verifyBankSignature({ ...debit, bankSignature: '' }, publicKey)).toBe(false);
  });
});

describe('signer round-2 checks 3–6 (contract order, exact codes)', () => {
  it('passes a fully consistent Round2Request', () => {
    const { round2 } = makeFixture();
    expect(runWall1TokenChecks(round2, publicKey)).toBeNull();
  });

  it('check 3: forged attestation → 401 WALL_1_UNVERIFIED', () => {
    const { round2 } = makeFixture();
    round2.debit = { ...round2.debit, bankSignature: ZERO_SIGNATURE };
    const f = runWall1TokenChecks(round2, publicKey);
    expect(f).toMatchObject({ status: 401, body: { error: 'WALL_1_UNVERIFIED' } });
  });

  it('check 4: debit priced for a different kWh amount → 401 WALL_1_MISMATCH', () => {
    const { round2 } = makeFixture();
    // valid bank signature for 50 kWh, but the request now claims 60 kWh
    round2.request = { ...round2.request, amountKwh: 60 };
    const f = runWall1TokenChecks(round2, publicKey);
    expect(f).toMatchObject({ status: 401, body: { error: 'WALL_1_MISMATCH' } });
  });

  it('check 4: debit for a different requestId → 401 WALL_1_MISMATCH', () => {
    const { round2 } = makeFixture();
    round2.request = { ...round2.request, requestId: 'REQ-other' };
    const f = runWall1TokenChecks(round2, publicKey);
    expect(f).toMatchObject({ status: 401, body: { error: 'WALL_1_MISMATCH' } });
  });

  it('check 4: request retargeted to a meter the bank did not attest → 401 WALL_1_MISMATCH', () => {
    const { round2 } = makeFixture();
    round2.request = { ...round2.request, meterId: 'MTR-2002' };
    const f = runWall1TokenChecks(round2, publicKey);
    expect(f).toMatchObject({ status: 401, body: { error: 'WALL_1_MISMATCH' } });
  });

  it('check 5: token not the one authorised by the debit → 400 TOKEN_NOT_DEBIT_BOUND', () => {
    const { round2 } = makeFixture();
    round2.tokenPayload = { ...round2.tokenPayload, meterId: 'MTR-9999' };
    round2.messageHex = bytesToHex(canonicalBytes(round2.tokenPayload));
    const f = runWall1TokenChecks(round2, publicKey);
    expect(f).toMatchObject({ status: 400, body: { error: 'TOKEN_NOT_DEBIT_BOUND' } });
  });

  it('check 6: messageHex not canonicalBytes(tokenPayload) → 400 MESSAGE_MISMATCH', () => {
    const { round2 } = makeFixture();
    round2.messageHex = bytesToHex(canonicalBytes({ ...round2.tokenPayload, meterId: 'MTR-0000' }));
    const f = runWall1TokenChecks(round2, publicKey);
    expect(f).toMatchObject({ status: 400, body: { error: 'MESSAGE_MISMATCH' } });
  });

  it('ordering: a forged signature is reported BEFORE an amount mismatch', () => {
    const { round2 } = makeFixture();
    round2.debit = { ...round2.debit, bankSignature: ZERO_SIGNATURE, amount: 999999 };
    const f = runWall1TokenChecks(round2, publicKey);
    expect(f?.body.error).toBe('WALL_1_UNVERIFIED');
  });
});

describe('FR-20 — one debit, one token is enforced at Wall 2 (not just the coordinator)', () => {
  it('the token nonce is deterministic in the debitRef (any token for a debit shares it)', () => {
    const { debit } = makeFixture();
    expect(buildTokenPayload(debit).nonce).toBe(deriveTokenNonce(debit.debitRef));
    // a second build from the same debit is byte-identical → only one valid token exists
    expect(canonicalBytes(buildTokenPayload(debit))).toEqual(canonicalBytes(buildTokenPayload(debit)));
  });

  it('a compromised coordinator cannot get a DIFFERENT-nonce token signed for one debit', () => {
    const { round2 } = makeFixture();
    // attacker keeps the same genuine debit but swaps in a fresh random nonce to double-mint
    round2.tokenPayload = { ...round2.tokenPayload, nonce: bytesToHex(randomBytes(16)) };
    round2.messageHex = bytesToHex(canonicalBytes(round2.tokenPayload));
    const f = runWall1TokenChecks(round2, publicKey);
    expect(f).toMatchObject({ status: 400, body: { error: 'TOKEN_NOT_DEBIT_BOUND' } });
  });

  it('a compromised coordinator cannot retarget one debit to a different meter', () => {
    const { round2 } = makeFixture();
    // attacker aims the token at another meter while keeping the same paid debit
    round2.request = { ...round2.request, meterId: 'MTR-8888' };
    round2.tokenPayload = { ...round2.tokenPayload, meterId: 'MTR-8888' };
    round2.messageHex = bytesToHex(canonicalBytes(round2.tokenPayload));
    const f = runWall1TokenChecks(round2, publicKey);
    // fails at check 4 (bank never attested MTR-8888) — before any signature is produced
    expect(f).toMatchObject({ status: 401, body: { error: 'WALL_1_MISMATCH' } });
  });
});
