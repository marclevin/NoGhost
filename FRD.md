# Two Walls — Functional Requirements Document

**Project:** Two Walls: Stopping Insider Fraud in Prepaid Electricity Tokens
**Context:** UZH course project — working proof-of-concept with real cryptographic and ledger primitives
**Companion vision doc:** [noghost.md](noghost.md)
**Version:** 0.2 (post adversarial review) · **Date:** 2026-07-15

---

## 1. Purpose and scope of this document

This document translates the vision in [noghost.md](noghost.md) into a concrete, buildable specification. It defines *what the system does*, the roles and interfaces, the data that crosses each boundary, and the functional behaviour of a demonstrable proof-of-concept (PoC) — including a React operations dashboard for the utility/consortium.

It is scoped to an **academic PoC built with real primitives**, not a production deployment. Where the PoC deliberately simplifies, this is stated explicitly (§9) so the boundary between "demonstrated" and "production-hardened" is never blurred.

### 1.1 What the PoC proves

The single claim the demo must make undeniable:

> **Systemic ghost-vending is impossible by construction.** A token cannot come into existence unless (a) the bank has witnessed a real debit *and* (b) an independent quorum of the consortium has jointly signed it. An insider acting alone — or a merchant lying about payment — is stopped by mathematics, not by policy.

The headline demo moment: **an insider attempts to generate a token with no confirmed debit, and the system rejects it live, on screen, with an attributable audit record.**

### 1.2 What is explicitly out of scope

- Physical extraction of a single meter's key (a per-meter attack yielding one meter's tokens — not systemic). See [noghost.md §Scope boundary](noghost.md).
- Settlement reversals / payment disputes — handled by ordinary payment rails.
- The real proprietary STS token encoding — we use a faithful stand-in (§4.3, §9).
- Production non-functional guarantees (HA, DR, formal key ceremony, HSM custody).
- The settlement leg by which municipalities/vendors pay the utility — assumed to happen outside this system.

### 1.3 Load-bearing assumptions (preconditions)

These are the conditions under which the core claim holds. They are stated openly because the design's integrity depends on them.

- **A. The threshold-held key is the *only* key any meter accepts.** The system assumes a **greenfield deployment**: every meter is provisioned to accept tokens produced *only* under the consortium's threshold-custodied key. All previously-issued keys and tokens are considered **null and void**. In the real world this means a one-time re-key/decommission of the legacy vending path — a *bootstrap*, not the fix. The fix is *where the key lives afterward*: ordinary meter-recoding fails because the new key lands back in one organisation's database; Two Walls changes the **custody model** so re-keying finally sticks. **For the PoC we simply assume meters are set up this way from day one and do not model the migration.**
- **B. Because of (A), no valid token can exist without a quorum ceremony.** This is why the system needs **no meter-side telemetry** to detect ghosts: a ghost token would have to be valid under the threshold key, and no such token can be produced without the consortium. Prevention is total *by construction*; there is no residual leakage channel to monitor. (The reconciliation panel therefore proves *internal conservation* — see §6.2-C — not external ghost-hunting.)
- **C. A merchant who pays for tokens they then misuse is intentionally in-bounds.** A merchant could request tokens for non-existent customers, or resell them — but they paid **real bank money** for every one, so the utility is made whole. This is not fraud against the system and is deliberately out of scope. The system guarantees *money received = tokens issued*; what a paying merchant does downstream is their own commercial affair.

---

## 2. Stakeholders and actors

| Actor | Role in system | In the PoC |
|---|---|---|
| **Customer** | Pays the merchant by any method; receives and enters the token. | Simulated; represented by a purchase event. |
| **Merchant (Requester)** | Submits a generation request; their bank account is debited per request. **Never touches key material.** | Simulated client that posts requests to the backend. |
| **Bank** | Witnesses and confirms the merchant's debit — the sole source of payment truth (Wall 1). | Mock bank service with a real API surface and a controllable "decline/confirm" toggle for the demo. |
| **Consortium party** (Utility, City/Municipality A, City/Municipality B) | Each holds one FROST key share; jointly generate tokens (Wall 2). Every member is a party that **loses money to the fraud** — the utility and the municipalities/vendors who collect from consumers and settle with the utility. | 3 independent signer processes (t-of-n), real FROST Ed25519. |
| **Utility / Consortium operator** | Monitors generation, reconciliation, consortium health, and fraud alerts. | **Primary dashboard user** (this document's UI). |

> **On composition:** there is no separate "auditor" role. The consortium is composed *only* of parties who directly benefit from eliminating the fraud (the utility and the paying municipalities/vendors). Reconciliation and the immutable trail are available to every consortium member through the ops dashboard — oversight is a *property of the shared ledger*, not a dedicated actor. The settlement leg by which municipalities/vendors pay the utility is outside this system's scope.

---

## 3. System architecture overview

Four cooperating components plus the dashboard:

```
  Merchant client ──(1) generation request──▶  ┌─────────────────────┐
                                               │  Coordinator /       │
  Mock Bank  ◀──(2) debit request────────────  │  Backend API         │
             ──(3) confirmed debit ref───────▶ │  (Node/TS)           │
                                               └──────────┬──────────┘
                                                          │
                          (4) confirm-then-generate       │
                                                          ▼
                        ┌──────────────── FROST t-of-n ceremony ───────────────┐
                        │  Signer A (Utility)  Signer B (City A)  Signer C (City B)
                        │      share_A              share_B          share_C     │
                        └───────────────────────────┬──────────────────────────┘
                                                     │ (5) combined signature → token
                                                     ▼
   XRPL testnet  ◀──(6) immutable authorisation record (hash + minimal fields)
                                                     │
                                                     ▼
                        React + Vite dashboard  ◀── live state (WebSocket/SSE)
```

- **Wall 1 (payment truth):** steps 2–3, owned by the bank.
- **Wall 2 (token truth):** step 5, owned by the FROST quorum. No single signer can produce a token.
- **Ledger (coordinate + witness + govern):** step 6 on XRPL testnet — never holds secrets.

### 3.1 Technology stack (PoC)

| Layer | Choice | Rationale |
|---|---|---|
| Ledger | **XRPL testnet** (xrpl.js) | Trusted-validator model, fast finality, native multi-sign/conditional primitives; matches the payment-shaped, consortium-shaped problem. |
| Threshold signing | **FROST (Ed25519)** | Modern threshold Schnorr; genuine t-of-n where the full key is **never assembled**. |
| Token | **Simplified signed stand-in** (§4.3) | Captures the generation/verification story without reimplementing proprietary STS. |
| Backend / Coordinator | **Node.js + TypeScript** | Shared language with frontend; strong XRPL + crypto libraries. |
| Bank | **Mock bank service** (same repo) | Real HTTP API; demo-controllable confirm/decline. |
| Frontend | **React + Vite + Tailwind**, **Recharts** for visuals | Fast, clean ops dashboard. |
| Live updates | **WebSocket or SSE** | Dashboard reflects generation/rejection events in real time. |

Production note (state in the report, do not build): the production architecture is **Hyperledger Fabric / Corda** for permissioned inter-institution privacy and fine-grained approval policy, with HSM-backed share custody.

**On the cryptographic primitive — an honesty note (see §9):** FROST produces Ed25519 Schnorr *signatures*, and the PoC's stand-in token is verified as such. Real STS meters do **not** verify a signature — they symmetrically decrypt a token derived from a master *vending key*. So a faithful production system would need **secure multi-party computation (MPC) over that single symmetric key** — i.e. the key is split into shares and the token is jointly computed such that the full key is never assembled — which is a harder and different problem than threshold Schnorr/ECDSA. FROST is used in the PoC as an honest, working stand-in for the one property that actually carries the argument: **a single key, split across parties, that no one party can use alone.** That property — not the specific signature algorithm — is what the demo proves.

---

## 4. Data model

### 4.1 Generation request

| Field | Type | Notes |
|---|---|---|
| `requestId` | UUID | Idempotency key. |
| `meterId` | string | Target meter. |
| `amountKwh` | number | Requested units. |
| `merchantId` | string | Vetted, revocable identity. |
| `timestamp` | ISO-8601 | Request creation. |
| `status` | enum | `PENDING → DEBIT_CONFIRMED → SIGNED → RECORDED → DELIVERED` **or** `REJECTED` **or** `REJECTED_ABANDONED` (debit confirmed then rolled back, FR-21). |

### 4.2 Confirmed-debit reference (from bank, Wall 1)

| Field | Type | Notes |
|---|---|---|
| `debitRef` | string | Bank-issued reference; the proof of payment. |
| `requestId` | UUID | Binds debit to request. |
| `amount` | number (currency) | Merchant account debited. |
| `confirmedAt` | ISO-8601 | Bank timestamp. |
| `bankSignature` | bytes | Bank attests the debit (so the coordinator cannot fake it). |

### 4.3 Token (stand-in)

A signed object — **not** a reconstruction of proprietary STS. Faithful to the trust story: valid only under the meter's key, verifiable independently.

| Field | Type | Notes |
|---|---|---|
| `meterId` | string | |
| `amountKwh` | number | |
| `nonce` | bytes | Prevents replay. |
| `signature` | bytes (Ed25519) | Produced by the FROST quorum; verifiable against the group public key. |

A simulated meter component verifies the signature and "dispenses" the units, closing the loop visibly.

### 4.4 On-chain authorisation record (XRPL, minimal + privacy-safe)

Per [noghost.md §On-chain vs off-chain](noghost.md): **no personal data, no payment details (POPIA-safe)** — a hash plus minimal reconciliation fields.

| Field | On-chain? | Notes |
|---|---|---|
| `requestHash` | ✅ | Hash of the request. |
| `debitRefHash` | ✅ | Hash of the bank debit reference. |
| `tokenHash` | ✅ | Hash of the issued token. |
| `signerSet` | ✅ | Which quorum members co-signed (attribution). |
| `timestamp` | ✅ | |
| Raw request / debit / token / PII | ❌ | Stay off-chain. |

---

## 5. Functional requirements

Requirements are numbered `FR-n`. **MUST** = required for the PoC; **SHOULD** = valuable if time permits.

### 5.1 Wall 1 — Payment (bank)

- **FR-1 (MUST):** On a generation request, the coordinator MUST request a debit from the bank against the merchant's account before any signing occurs.
- **FR-2 (MUST):** The system MUST NOT begin the signing ceremony until the bank returns a **confirmed, bank-signed** debit reference (*confirm-then-generate*).
- **FR-3 (MUST):** The coordinator MUST verify the `bankSignature` on the debit reference; an unverifiable or absent confirmation MUST cause rejection.
- **FR-4 (MUST):** A declined or timed-out debit MUST transition the request to `REJECTED` with a reason, and MUST produce no token.

### 5.2 Wall 2 — Threshold generation (consortium)

- **FR-5 (MUST):** Token signing MUST require a threshold **t-of-n** (PoC: **2-of-3**) of independent signer processes.
- **FR-6 (MUST):** The full signing key MUST NOT be assembled at any point — each signer contributes a partial using only its share (FROST).
- **FR-7 (MUST):** A signing attempt with fewer than `t` participating signers MUST fail to produce a valid token.
- **FR-8 (MUST):** Each signer MUST **independently verify the bank's signature** on the confirmed-debit reference before contributing its partial — not merely trust a "confirmed" flag asserted by the coordinator. This is what makes the coordinator non-load-bearing: a compromised coordinator with no genuine bank-signed debit cannot induce any signer to sign.
- **FR-9 (SHOULD, governance-only):** Each signer MUST be able to **refuse** a request, and the refusal MUST be logged and attributable. This is a *governance capability* (surfaced in §6.2-D), **not** a scripted demo path — the live demo does not dramatise a signer hold.

### 5.3 Ledger — coordinate, witness, govern

- **FR-10 (MUST):** Every successful authorisation MUST be written as an immutable record on XRPL testnet (§4.4).
- **FR-11 (MUST):** The record MUST contain hashes only (no PII/payment detail) plus the `signerSet` for attribution.
- **FR-12 (MUST):** The system MUST expose a **reconciliation check**: every issued token maps to exactly one on-chain record and one confirmed debit; any token without both is flagged as illegitimate and attributable.
- **FR-13 (SHOULD):** Consortium membership (who may hold a share / sign) MUST be governable — a member can be listed/revoked, and this change is itself recorded.
- **FR-14 (SHOULD):** A small per-request fee/nonce MUST guard against spam/DoS (anti-spam, not validator payment).

### 5.4 End-to-end orchestration

- **FR-15 (MUST):** The coordinator MUST enforce the strict order: request → debit → confirm → threshold sign → record → deliver.
- **FR-16 (MUST):** Requests MUST be idempotent on `requestId` (no double-generation on retry).
- **FR-17 (MUST):** Any failure at any step MUST leave the system in a consistent state with **no partial token** existing.
- **FR-20 (MUST) — one debit, one token:** A confirmed `debitRef` MUST be consumable exactly once. A request whose `debitRef` has already produced a token MUST be rejected. This binds the two walls one-to-one and prevents replaying a single debit into multiple tokens.
- **FR-21 (MUST) — abandonment / rollback:** If the debit is confirmed but the ceremony or recording then fails (an *internal* fault, distinct from a customer dispute), the system MUST **abandon the payment leg**: it signals the bank to reverse/void the debit and the customer is refunded. The request ends `REJECTED (abandoned)` with no token and no consumed debit. (The bank reversal signal is mocked in the PoC.) This closes the "money taken, no goods" gap that ordinary dispute handling does not cover.

### 5.5 Merchant boundary integrity

- **FR-18 (MUST):** The merchant interface MUST expose only *request submission and status* — no access to key material, signing, or the ceremony.
- **FR-19 (MUST):** The merchant MUST be identifiable, and requests attributable to a merchant identity (vetted/revocable).

---

## 6. The dashboard — utility / consortium operations view

**Primary user:** utility/consortium operator. **Framework:** React + Vite + Tailwind + Recharts. **Live:** WebSocket/SSE.

### 6.1 Design goals

1. Make the **"fraud is impossible"** story visible at a glance.
2. Show the **two walls** as two independent, observable checks on every transaction.
3. Provide **reconciliation** (tokens ⇄ debits ⇄ ledger) as first-class content — the shared-ledger oversight available to every consortium member.

### 6.2 Screens / panels

**A. Live Generation Feed** (landing)
- Real-time stream of requests, each showing its journey through the pipeline as a horizontal stepper: `Request → Debit ✓ → Quorum 2/3 ✓ → Recorded ✓ → Delivered`.
- Rejected requests appear in red with the failing wall highlighted and a reason.
- **FR-D1 (MUST):** Feed updates live as backend events arrive.

**B. Two Walls Status**
- Two prominent status tiles: **Wall 1 — Bank** (debit confirm rate, last confirmations) and **Wall 2 — Consortium** (signers online, current threshold, recent ceremonies).
- Per-signer health chips (Utility / City A / City B: online, share held, last partial).
- **FR-D2 (MUST):** If any wall would block generation (bank down, quorum unreachable), the tile reflects it.

**C. Reconciliation / Conservation**
- The core oversight artifact: a running ledger with `Tokens issued`, `Confirmed debits`, `On-chain records`, and a **Δ (internal conservation)** counter that MUST read **zero**.
- **What Δ proves — stated precisely:** this is an *internal conservation / self-consistency* check — it proves the three system-side facts (a token was issued, a debit backed it, a record was written) never diverge. It is **not** an external ghost-detector, because — per assumption 1.3-B — no valid token can exist *without* passing through this pipeline in the first place. Prevention is total by construction; Δ demonstrates the pipeline itself never leaks. The demo must not imply Δ catches tokens forged outside the system — under the greenfield assumption, none can be.
- Recharts time-series of tokens vs debits (they overlay perfectly by construction).
- Table drill-down: each token → its `debitRef`, `signerSet`, on-chain tx link (XRPL explorer).
- **FR-D3 (MUST):** Any nonzero Δ is surfaced as a top-level integrity alert with attribution (it would indicate a *system fault or tampering*, since honest operation makes divergence impossible).

**D. Consortium Governance**
- List of consortium members, share status, threshold policy (t-of-n), listing/revocation actions and their audit trail.
- **Bonding/slashing is represented conceptually here** (a displayed bond posture per member with an explanatory note) — the PoC does **not** implement on-chain economic bonds or live slashing.
- **FR-D4 (SHOULD):** Reflect FR-13 membership changes.

**E. Audit Log / Immutable Trail**
- Chronological, filterable view of on-chain authorisation records; each row links to the XRPL testnet transaction.
- **FR-D5 (MUST):** Every record is independently verifiable off the dashboard (link out).

### 6.3 The demo control ("insider attack" switch)

- **FR-D6 (MUST):** A demo control panel lets the operator/presenter:
  1. Submit a **legitimate** purchase → watch it flow green through both walls and deliver a token.
  2. Trigger an **insider ghost-vend attempt**: request a token while forcing the bank to *decline/omit* the debit. The dashboard MUST show the request **rejected at Wall 1**, no token produced, and an attributable alert — the headline moment.
  3. Trigger a **collusion-short attempt**: only 1 of 3 signers participates → rejected at Wall 2 (below threshold), demonstrating no single insider can generate.

This panel is the scripted spine of the live demo (§8).

---

## 7. Non-functional requirements (PoC-appropriate)

- **NFR-1 Transparency:** Every rejection states *which wall* failed and *why*.
- **NFR-2 Attribution:** Every generation and every refusal is attributable to identities/signer sets.
- **NFR-3 Privacy (POPIA-aligned):** No PII or payment detail on-chain; hashes + minimal fields only.
- **NFR-4 Reproducibility:** The demo runs deterministically from a seed/script; signers and bank start from a known state.
- **NFR-5 Observability:** Backend emits structured events for every state transition (feeds the dashboard and the audit log).
- **NFR-6 Portability:** Runs locally (docker-compose or npm scripts) against XRPL **testnet**; no production infra required.
- **NFR-7 Availability (production concern, acknowledged not solved):** In production, generation requires a live quorum — if `t` signers cannot be reached, *no one can buy electricity*. A real deployment must treat generation-availability as a first-class SLA (quorum redundancy, `n > t` with spare signers). The PoC does not engineer for this; it is named as a production requirement. 2-of-3 tolerates one signer offline, which is enough to demonstrate the property.
- **NFR-8 Ledger metadata privacy (PoC caveat):** XRPL is a *public* ledger. Even hashes + `signerSet` + timestamps leak transaction volume and timing patterns to outside observers via correlation. This is acceptable for a testnet PoC; the production move to permissioned **Hyperledger Fabric / Corda** removes the public-metadata exposure.

---

## 8. Demo script (the narrative the FRD must support)

1. **Baseline** — dashboard open, all signers online, Δ = 0.
2. **Legitimate purchase** — submit; watch the stepper go green across both walls; token delivered; simulated meter dispenses units; on-chain record appears; Δ stays 0.
3. **Insider ghost-vend** — force bank to withhold the debit; submit; **rejected at Wall 1**; no token; alert raised, attributable. *"The money didn't move, so the token was never born."*
4. **Collusion-short** — only 1 signer participates; **rejected at Wall 2**; *"One insider holds a useless fragment."*
5. **Reconciliation** — show the conservation panel: tokens = debits = records, Δ = 0. Frame it honestly: *"Every token that exists came through both walls — and it must, because meters accept nothing else. There is no ghost to hunt; the pipeline is the only door, and both walls guard it."*

---

## 9. Explicit PoC simplifications (honesty boundary)

| Area | PoC | Production |
|---|---|---|
| Threshold primitive | FROST Ed25519, 2-of-3, local processes — a working stand-in for "one key, split, unusable by any single party" | **Secure MPC over the symmetric vending key** (meters decrypt, they don't verify signatures — so threshold *signing* is not the production primitive); HSM share custody; formal DKG ceremony |
| Token | Signed stand-in object + simulated meter | Proprietary STS 20-digit encoding on real meters |
| Meter provisioning | Assumed greenfield — meters accept only the threshold key (§1.3-A) | One-time re-key + decommission of the legacy vending path |
| Bank | Mock service with signed confirmations + mocked reversal signal (FR-21) | Real bank rail integration + settlement + reversals |
| Ledger | XRPL testnet (public) | Hyperledger Fabric / Corda (permissioned, inter-party privacy, approval policy) |
| Bonding/slashing | Conceptual representation in governance view | On-chain economic bonds with real slashing |
| Consortium | 3 simulated parties (Utility, City A, City B) on one host | Independent institutions — utility + paying municipalities/vendors — on separate infrastructure |

Naming these is a strength: the PoC demonstrates the *mechanism* end-to-end with real crypto and a real ledger, and the report states precisely what a production build would harden.

---

## 10. Resolved decisions and open questions

**Resolved:**
- **Single utility ops view** — no separate merchant UI; reconciliation and immutable-trail oversight live inside the ops dashboard as panels C and E, available to every consortium member.
- **Bonding/slashing** — conceptual representation in the governance view only (§6.2-D); not implemented.
- **Signer refusal (FR-9)** — governance capability only; not a scripted demo beat.

**Still open:**
1. **Merchant vetting/revocation:** demonstrate a revoked-merchant rejection, or leave as stated capability only?
2. **Deployment packaging:** docker-compose vs. plain npm scripts for the demo runner?
```

