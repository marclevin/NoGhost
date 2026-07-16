# Two Walls — Security Model & Adversarial Review

This note records the threat model the PoC defends, the adversarial review it was subjected to, and the
hardening that resulted. It is the honest companion to the headline claim in [FRD.md](FRD.md) §1.1:

> **Systemic ghost-vending is impossible by construction.** A token cannot come into existence unless
> (a) the bank has witnessed a real debit *and* (b) an independent quorum of the consortium has jointly signed it.

## Threat model

The adversary is an **insider who controls the coordinator** (or a merchant colluding with one). The design's
central promise is that the coordinator is **non-load-bearing**: even fully compromised, it cannot cause a token
to exist without both walls. Concretely it must not be able to:

- induce a signer to sign without a genuine, bank-signed debit (Wall 1 / FR-8); or
- turn value that was paid once into more than one redeemable token (FR-20); or
- aim a paid-for token at a meter the payment did not authorise.

Out of scope (per FRD §1.2): extracting a single meter's key, payment disputes, and a paying merchant who
misuses tokens they actually bought (money received = tokens issued is still honoured).

## The two walls

- **Wall 1 — payment truth.** The mock bank signs each debit attestation with its own Ed25519 key. Both the
  coordinator (FR-3) and **every signer independently** (FR-8) verify that signature against a bank public key
  **pinned out-of-band at boot** — never taken from the coordinator. No genuine debit ⇒ no signature.
- **Wall 2 — token truth.** A real **FROST(Ed25519, SHA-512)** 2-of-3 threshold signature
  ([server/src/frost/frost.ts](server/src/frost/frost.ts), RFC 9591). The group key is split by a trusted dealer
  (declared PoC simplification) and **never reassembled**; each signer contributes a partial from its share alone.
  Fewer than 2 signers cannot produce a valid signature. The aggregate is a standard Ed25519 signature, so the
  simulated meter verifies it with a stock verifier and no knowledge of FROST.
- **Ledger — witness.** Every authorisation is written to the XRPL testnet as hashes only (POPIA-safe, FR-11).

## What the adversarial review found

A multi-agent review (four independent lenses, every finding adversarially re-verified) probed the running stack.
It surfaced **one architecturally important defect**, confirmed by two reviewers and reproduced live:

> **FR-20 was enforced only by the coordinator.** The "one debit, one token" rule lived solely in the
> coordinator's in-memory `consumedDebitRefs` map. The signers kept no record of debits they had signed for, and
> the token nonce was coordinator-chosen at random. So a compromised coordinator could take **one** genuine
> bank-signed debit and drive **many** FROST ceremonies against the signers directly — each with a fresh random
> nonce — obtaining many distinct, meter-valid tokens. These bypassed the coordinator's own registry, created no
> pipeline record, and were therefore invisible to reconciliation and the ledger. The wall meant to bind one debit
> to one token rested on the very component assumed hostile.

A reviewer proved it live: one debit → two valid quorum-signed tokens.

## The fix — bind the token to the debit at Wall 2

The binding was moved out of the coordinator and into the walls that are actually independent:

1. **The bank attests the economics.** `meterId` and `amountKwh` are now inside the bank-signed debit payload
   (`DebitSignedPayload`). Once a signer verifies the bank signature, those fields are trustworthy without trusting
   the coordinator.
2. **The token is a deterministic function of the debit.**
   `nonce = deriveTokenNonce(debitRef)` and the payload is `buildTokenPayload(debit)` =
   `{ meterId, amountKwh, debitRef, nonce }` — all derived from the (signed) debit
   ([server/src/common/token.ts](server/src/common/token.ts)). There is therefore **exactly one valid token message
   per debit**.
3. **Each signer enforces it.** Round-2 verification now rejects any token that is not
   `buildTokenPayload(debit)` (`TOKEN_NOT_DEBIT_BOUND`) and any request whose meter/units differ from the
   bank-attested debit (`WALL_1_MISMATCH`) — see [server/src/signer/verify.ts](server/src/signer/verify.ts).
4. **The meter collapses replays.** Because the nonce is fixed by the debit, any two tokens for one debit share a
   nonce; the meter's replay guard (and an explicit `debitRef` guard) admit only the first.

**Consequence:** a compromised coordinator that reruns the ceremony with the same debit can only ever obtain a
signature over the *same* token — never a second distinct redeemable one. FR-20 is now a property of Wall 2 and the
meter, not of the coordinator. Verified live: the reviewer's exact double-mint attack is refused by every signer
with `TOKEN_NOT_DEBIT_BOUND`, and the retarget variant with `WALL_1_MISMATCH`. Unit tests in
[server/test/bank-signer.checks.test.ts](server/test/bank-signer.checks.test.ts) lock the property in.

### Other confirmed fixes

| Area | Change |
|---|---|
| Demo clarity (FR-D6) | Pre-flight quorum check before the debit → collusion-short rejects at Wall 2 with **no money taken**; post-debit path stays as the FR-21 race backstop |
| Reconciliation (FR-12 / FR-D3) | Counts **distinct** debitRefs / tx hashes so a same-debit double-mint reads Δ≠0 instead of netting to zero |
| Ledger consistency (FR-17) | Meter **pre-verifies** the token before the immutable XRPL write — no orphan on-chain record for a token the meter would reject |
| Signer hygiene | Single-use FROST nonces deleted on every terminal round-2 outcome, not only on success |
| Anti-spam (FR-14) | Per-merchant sliding-window rate limit on request submission |

## Honest boundary (unchanged, FRD §9)

The PoC demonstrates the *mechanism* with real crypto and a real test ledger. It still simplifies: trusted-dealer
keygen (not DKG + HSM); a signed stand-in token (real meters decrypt a symmetric STS key — production needs MPC over
that key, a different primitive with the same custody property); a mock bank; XRPL testnet rather than a permissioned
ledger; and conceptual (not enforced) bonding/slashing.
