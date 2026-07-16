# Two Walls — Stopping Insider Fraud in Prepaid Electricity Tokens

A working proof-of-concept (UZH course project) that makes **systemic ghost-vending impossible by
construction**: a prepaid electricity token cannot come into existence unless **(1)** a bank has
witnessed a real debit (*Wall 1*) **and** **(2)** an independent 2-of-3 consortium quorum has jointly
signed it with a threshold key that no single party holds (*Wall 2*). Every authorisation is witnessed
immutably on the **XRPL testnet**.

Docs: [FRD.md](FRD.md) (functional spec) · [noghost.md](noghost.md) (vision) · [SECURITY.md](SECURITY.md) (threat model + adversarial review) · [CONTRACTS.md](CONTRACTS.md) (service contracts).

> **Security note.** "One debit, one token" (FR-20) is enforced at **Wall 2**, not by the coordinator: the token is a
> deterministic function of the bank-signed debit (`nonce = H(debitRef)`, and the bank attests `meterId`/`amountKwh`),
> so each signer independently refuses to sign anything but the one token a debit authorises. A compromised
> coordinator therefore cannot replay one paid debit into multiple tokens. See [SECURITY.md](SECURITY.md).

## Architecture

| Component | Port | What it is |
|---|---|---|
| Coordinator | 4000 | Orchestrates request → debit → confirm → threshold-sign → record → deliver (FR-15). Serves the dashboard's API + WebSocket. |
| Mock bank | 4100 | Wall 1. Signs debit confirmations with its own Ed25519 key; demo-switchable to decline/omit/timeout. |
| Signer: utility | 4201 | Wall 2, FROST participant 1 — holds one key share, independently verifies the bank's signature before contributing a partial (FR-8). |
| Signer: city-a | 4202 | Wall 2, FROST participant 2. |
| Signer: city-b | 4203 | Wall 2, FROST participant 3. |
| Dashboard | 5173 | React + Vite + Tailwind + Recharts ops console (live feed, two-walls status, reconciliation, governance, audit trail, demo controls). |

Cryptography: **FROST(Ed25519, SHA-512)** per RFC 9591, implemented in
[server/src/frost/frost.ts](server/src/frost/frost.ts) on `@noble/curves`. The aggregate signature is a
**standard Ed25519 signature** — the simulated meter verifies tokens with a stock verifier and the group
public key, knowing nothing about FROST. Key generation uses a trusted dealer (declared PoC
simplification, FRD §9); the group secret is discarded at dealing time and **never reassembled**.

## Quick start

```bash
npm install
npm run setup          # one-time key ceremony → server/keys/ (FROST shares + bank keypair)
npm run dev            # bank + 3 signers + coordinator + dashboard, all at once
```

Then open **http://localhost:5173**.

Requires a `.env` at the repo root with a funded XRPL **testnet** wallet:

```
XRP_WALLET_ADDRESS=r...
XRP_WALLET_SECRET=s...
```

(Get one at https://xrpl.org/resources/dev-tools/xrp-faucets — the faucet funds it automatically.)

## The demo (FRD §8)

Use the **Demo Control** panel in the dashboard:

1. **Legitimate purchase** — watch the stepper go green through both walls: debit confirmed → 2-of-3
   quorum signs → record validated on XRPL (explorer link) → simulated meter verifies and dispenses. Δ stays 0.
2. **Insider ghost-vend** — the bank is forced to decline (no real customer payment). The request is
   **rejected at Wall 1**, no token exists, and a critical, attributable alert fires.
   *The money didn't move, so the token was never born.*
3. **Collusion-short** — only 1 of 3 signers is reachable. The request is **rejected at Wall 2** below
   threshold; no round-1 commitment is ever produced. *One insider holds a useless fragment.*
4. **Reconciliation** — tokens = debits = on-chain records, **Δ = 0**: internal conservation, because the
   pipeline is the only door and both walls guard it.

## Useful commands

```bash
npm test                       # unit tests (FROST threshold properties, etc.)
npm run backend                # backend only (no dashboard)
npm -w server run xrpl:smoke   # one test memo tx against XRPL testnet
npm run typecheck
```

## Honesty boundary (FRD §9)

This PoC demonstrates the *mechanism* with real cryptography and a real (test) ledger. It deliberately
simplifies: trusted-dealer keygen instead of DKG+HSM; a signed stand-in token instead of proprietary STS
encoding (real meters decrypt with a symmetric vending key — production would need MPC over that key, a
different primitive with the same custody property); a mock bank; XRPL testnet instead of a permissioned
ledger (Hyperledger Fabric / Corda in production); conceptual (not enforced) bonding/slashing; three
consortium processes on one host instead of three institutions.
