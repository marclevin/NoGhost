# Two Walls — Service & Event Contracts (build-time source of truth)

Implements [FRD.md](FRD.md). All TypeScript types referenced here are **defined in
[server/src/common/types.ts](server/src/common/types.ts)** — that file is normative; this doc explains wiring.
Shared constants/ports live in [server/src/common/config.ts](server/src/common/config.ts); canonical
serialization + hashing in [server/src/common/canonical.ts](server/src/common/canonical.ts); FROST crypto in
[server/src/frost/frost.ts](server/src/frost/frost.ts).

**Rules for all services**
- TypeScript ESM, run via `tsx`. Express + `cors()` enabled. JSON bodies.
- No new npm dependencies — everything needed is already in `server/package.json` / `dashboard/package.json`.
- Never modify files outside your assigned directory. Never touch `package.json`, tsconfigs, or `common/`/`frost/`.
- All signatures are over `canonicalBytes(value)` (sorted-key JSON, UTF-8). All hashes are `sha256` hex.
- Keys come from `server/keys/` (created by `npm run setup:keys -w server`):
  `group.json`, `signer-<signerId>.json`, `bank.json`, `bank.pub.json` (shapes in setup-keys.ts).
- Structured logging: `console.log(JSON.stringify({at: new Date().toISOString(), svc, evt, ...}))` is fine (NFR-5).
- Ports: coordinator **4000**, bank **4100**, signers **4201/4202/4203** (utility / city-a / city-b).

---

## 1. Bank service — `server/src/bank/index.ts` (port 4100)

State: `mode: BankMode` (default `CONFIRM`), debit log (in-memory), reversal log.
Signing key: `keys/bank.json` (`secretKey` hex) → sign with `ed25519.sign` from `@noble/curves/ed25519`.

| Endpoint | Behaviour |
|---|---|
| `GET /api/health` | `{ up: true, mode }` |
| `GET /api/public-key` | `{ publicKey }` (hex, from `keys/bank.pub.json`) |
| `GET /api/admin/mode` | `{ mode }` |
| `POST /api/admin/mode` `{ mode: BankMode }` | switch demo mode; respond `{ mode }` |
| `POST /api/debits` `DebitRequest` | see below |
| `POST /api/debits/:debitRef/reverse` | FR-21: mark reversed → `{ reversed: true, debitRef }`; unknown ref → 404 |
| `GET /api/debits` | array of `{ debit, reversed, outcome }` for observability |

`POST /api/debits` by mode:
- `CONFIRM` → 200 `DebitConfirmation`: `debitRef = 'DBT-' + 12 hex chars`, `confirmedAt = now`,
  `bankSignature = ed25519.sign(canonicalBytes({debitRef, requestId, amount, currency, confirmedAt}), secretKey)` hex.
  **Field order irrelevant — canonicalBytes sorts.** The signed payload is exactly the `DebitSignedPayload` type.
- `DECLINE` → 402 `{ declined: true, reason: 'Debit declined — no funds movement authorised.' }`
- `OMIT_SIGNATURE` → 200 `DebitConfirmation` but with `bankSignature` = 64 zero bytes hex (a forged/absent attestation —
  used to demo FR-3/FR-8: coordinator or signers must reject it).
- `TIMEOUT` → wait 8s then 504 `{ timeout: true }`.
- Same `requestId` re-submitted while a prior confirmation exists → return the SAME `DebitConfirmation` (idempotent).

## 2. Signer service — `server/src/signer/index.ts` (ports 4201-3)

Started as `tsx src/signer/index.ts <signerId>`; look up port/identifier in `SIGNERS` from config.
Loads `keys/signer-<signerId>.json` (secret share) and **pins the bank public key from `keys/bank.pub.json` at boot**
(FR-8: trust anchor is provisioned out-of-band, NOT taken from the coordinator).

State: `online` (demo toggle, default true), `refuse` (FR-9 governance flag, default false),
`sessions: Map<sessionId, {nonces, createdAt}>` (delete after round2 — nonces are single-use), `lastPartialAt`.

| Endpoint | Behaviour |
|---|---|
| `GET /api/health` | `SignerHealth` (with `revoked: false`; coordinator overlays governance) |
| `POST /api/admin/online` `{ online: boolean }` | demo toggle. When offline, **round1/round2 return 503** |
| `POST /api/admin/refuse` `{ refuse: boolean, reason? }` | FR-9 flag |
| `POST /api/ceremony/round1` `{ sessionId }` | run `frost.round1(secretShare)`, store nonces under sessionId, return `Round1Response` |
| `POST /api/ceremony/round2` `Round2Request` | the **Wall-2 checks below**, then `frost.round2Sign`, delete session, return `Round2Response` |

Round-2 independent verification (THE POINT of the design — each signer checks, never trusts the coordinator):
1. `refuse` flag set → 403 `{ refused: true, signerId, reason }` (coordinator logs attributably).
2. Session exists (round1 happened) → else 400 `{ error: 'unknown session' }`.
3. **Bank signature verifies** with the PINNED bank key over `canonicalBytes({debitRef, requestId, amount, currency, confirmedAt})` → else **401 `{ error: 'WALL_1_UNVERIFIED', detail }`** (FR-8).
4. `debit.requestId === request.requestId` and `debit.amount === priceZar(request.amountKwh)` and `debit.currency === CURRENCY` → else 401 `WALL_1_MISMATCH`.
5. `tokenPayload.meterId === request.meterId && tokenPayload.amountKwh === request.amountKwh` → else 400 `TOKEN_MISMATCH`.
6. `messageHex === bytesToHex(canonicalBytes(tokenPayload))` → else 400 `MESSAGE_MISMATCH`.
7. All good → `round2Sign({identifier, secretShare, nonces, message, commitments, groupPublicKey})`, delete session, update `lastPartialAt`, return `{ signerId, identifier, zi }`.

## 3. Coordinator — `server/src/coordinator/` (port 4000)

Express + `ws` WebSocketServer on the same HTTP server, path `/ws`.
Suggested files: `index.ts` (app + routes), `pipeline.ts` (orchestration), `store.ts` (in-memory state + event bus),
`xrpl.ts` (ledger writer), `meter.ts` (simulated meter), `demo.ts` (scenarios). Structure is yours; contract below is not.

### 3.1 Pipeline (FR-15 strict order) — `runPipeline(record)`

`PENDING` → bank debit → `DEBIT_CONFIRMED` → ceremony → `SIGNED` → XRPL → `RECORDED` → meter → `DELIVERED`.
Emit `request.updated` (full `PipelineRecord`) on EVERY transition. Each transition appends to `history`.

1. **Policy gate:** unknown merchant or `revoked` merchant → REJECTED wall `POLICY`, reason + attribution (FR-19).
2. **Wall 1:** `POST bank /api/debits` with `{requestId, merchantId, amount: priceZar(amountKwh), currency}`.
   - 402/504/network error → `REJECTED`, wall `WALL_1_BANK`, attribution = merchantId, **alert (severity critical, title "Ghost-vend attempt blocked at Wall 1")** when mode ≠ CONFIRM caused it.
   - **FR-3: coordinator verifies `bankSignature` itself** (same check as signers) → invalid → REJECTED wall `WALL_1_BANK`, reason `BANK_SIGNATURE_INVALID`.
   - **FR-20: `debitRef` already consumed by a *different* request → REJECTED** wall `POLICY`, reason `DEBIT_ALREADY_CONSUMED`.
3. **Wall 2 ceremony:**
   - Health-poll ACTIVE (non-revoked) signers; online ones are candidates. `< t` candidates → **REJECTED wall `WALL_2_CONSORTIUM`, reason `BELOW_THRESHOLD (1 of 3 signers available, need 2)`** + warning alert. **No round-1 calls are made** — but if debit was already confirmed, this is an internal fault → FR-21 (below).
   - Else pick the first `t=2` online by identifier. Build `tokenPayload = {meterId, amountKwh, nonce: 16 random bytes hex}`.
   - round1 → collect commitments; round2 with full `Round2Request`; **verify each partial with `verifySignatureShare`** (attribution: a bad partial names the signer in an alert); `aggregate`; **verify final signature vs group public key** (sanity). Set `signerSet` = participating signerIds, status `SIGNED`.
   - A signer 403-refusing → log governance entry + warning alert (attributable), swap in the spare signer if online, else FR-21.
4. **Ledger:** submit AccountSet memo (below) → `LedgerRecord`, status `RECORDED`. Failure → FR-21.
5. **Meter:** verify token signature against group public key with `verifySignature` (+ reject reused nonce), credit meter balance, status `DELIVERED`, emit `meter.updated`. This closes the loop (§4.3).
6. **FR-21 abandonment:** any failure AFTER debit confirmation → `POST bank /api/debits/:ref/reverse`, set `debitReversed`, status `REJECTED_ABANDONED`, wall = failing stage, info/warning alert "debit reversed, customer refunded".
7. **FR-16 idempotency:** `POST /api/requests` with an existing `requestId` returns the existing record, never re-runs.
8. Wrap the whole pipeline so **no unhandled rejection can leave a request non-terminal** (FR-17).

### 3.2 XRPL (`xrpl.ts`)

- `Client(XRPL_WSS)` from config; `Wallet.fromSeed(XRP_WALLET_SECRET)`. Connect lazily once, reuse; reconnect on drop.
- Tx: `AccountSet` from/to own account with one Memo:
  `MemoType = convertStringToHex('twowalls/authorisation')`, `MemoFormat = convertStringToHex('application/json')`,
  `MemoData = convertStringToHex(JSON.stringify({v:1, requestHash, debitRefHash, tokenHash, signerSet, ts}))`.
  - `requestHash = hashValue(request)` · `debitRefHash = sha256Hex(debit.debitRef)` · `tokenHash = hashValue(token)`.
- `submitAndWait`; require `TransactionResult === 'tesSUCCESS'` → `LedgerRecord` with `explorerUrl = XRPL_EXPLORER_TX(hash)`.
- Serialize submissions through a simple promise queue (one at a time — account sequence numbers).

### 3.3 HTTP API (all under `/api`)

| Endpoint | Behaviour |
|---|---|
| `POST /api/requests` `{meterId, amountKwh, merchantId, requestId?}` | validate (kwh > 0 finite, strings), create `PipelineRecord`, **run pipeline async**, 202 `{ requestId }`. Existing requestId → 200 `{ requestId, existing: true }` |
| `GET /api/state` | full `Snapshot` |
| `GET /api/requests` / `GET /api/requests/:id` | records (newest first) |
| `GET /api/reconciliation` | `Reconciliation` |
| `GET /api/consortium` | `ConsortiumStatus` |
| `GET /api/audit` | `LedgerRecord[]` newest first |
| `GET /api/merchants` | `Merchant[]` |
| `POST /api/merchants/:id/revoke` · `/reinstate` | flip flag + governance log + `governance.updated` event |
| `POST /api/governance/members/:signerId/revoke` · `/reinstate` | FR-13: excluded from ceremonies + log + event |
| `POST /api/demo/bank-mode` `{ mode }` | proxy to bank admin, then emit `bank.status` |
| `POST /api/demo/signers/:signerId` `{ online }` | proxy to signer admin, then emit `consortium.status` |
| `POST /api/demo/scenario` `{ kind: 'legit' \| 'ghost' \| 'collusion-short' }` | §6.3: set preconditions, submit a demo request (rotating seeded meters/merchants), 202 `{ requestId, kind }`; **restore preconditions automatically when the request reaches a terminal state** |

Seed data: merchants `MER-001 "Thabo's Spaza"`, `MER-002 "QuickPay Kiosk"`, `MER-003 "PayZone CityMall"` (vetted);
meters `MTR-1001..MTR-1006`. Seeded at boot (NFR-4).

### 3.4 Live state (WS `/ws`)

- On connect: send `{type:'hello', state: Snapshot}`.
- Broadcast `WsEvent`s per types.ts on every change. Poll signer health + bank health every 3s; broadcast
  `consortium.status` / `bank.status` **only on change**.
- `Reconciliation`: computed over terminal-state requests only. DELIVERED → +1 token, +1 debit, +1 record.
  REJECTED → nothing. REJECTED_ABANDONED → nothing (debit reversed). `delta = max pairwise divergence` (i.e.
  `Math.max(|tokens-debits|, |tokens-records|)`); nonzero → **critical alert (FR-D3)**. `series` = cumulative counts
  at each DELIVERED event (cap 200 points).
- Alerts kept newest-first, cap 100. Requests cap 200.

## 4. Dashboard — `dashboard/` (Vite dev server 5173)

- Vite + React 18 + TypeScript + Tailwind v4 (`@tailwindcss/vite` plugin) + Recharts. Files: `index.html`,
  `vite.config.ts`, `src/main.tsx`, `src/App.tsx`, `src/types.ts` (mirror of server types), components as needed.
- `vite.config.ts`: react + tailwindcss plugins; `server.proxy = { '/api': 'http://localhost:4000', '/ws': { target: 'ws://localhost:4000', ws: true } }`.
- Connect WS to `` `ws://${location.host}/ws` `` (goes through the Vite proxy). Reconnect with backoff; on reconnect
  re-sync via `hello`/`GET /api/state`. A store (useReducer/context) applies `WsEvent`s to the `Snapshot`.
- Panels per FRD §6.2 (single-page ops dashboard, tabbed or scrollable sections): A Live Generation Feed (stepper),
  B Two Walls Status, C Reconciliation (Δ tile + Recharts time-series + drill-down table w/ explorer links),
  D Governance (members, threshold, conceptual bond posture, merchant + member revocation actions),
  E Audit Log (on-chain records, link out), + §6.3 Demo Control panel (three scripted buttons + raw toggles).

---

## Demo scenario semantics (§6.3 / §8)

- **legit**: bank→CONFIRM, all signers online, submit (e.g. 50 kWh). Expect full green: DELIVERED, Δ stays 0.
- **ghost**: bank→DECLINE, submit, expect REJECTED at WALL_1_BANK + critical alert; then bank→CONFIRM restored.
- **collusion-short**: city-a + city-b offline (only utility online), submit, expect REJECTED at WALL_2_CONSORTIUM.
  Since the pre-flight quorum check (below) runs BEFORE the bank debit, **no debit is taken** — clean Wall-2
  rejection, no money moved; then signers restored online.

---

## Post-review hardening (adversarial review, 2026-07-16)

A multi-agent adversarial review found that FR-20 ("one debit, one token") was enforced only by the coordinator's
in-memory registry — but the coordinator is the assumed adversary, so a compromised coordinator could replay one
genuine bank-signed debit into unlimited tokens by calling the signers directly. Changes that move the binding into
the independent walls (see [SECURITY.md](SECURITY.md)):

1. **Token is bound to the debit at Wall 2.** The bank now signs `meterId` + `amountKwh` (added to `DebitRequest`,
   `DebitConfirmation`, `DebitSignedPayload`). The token nonce is **deterministic**: `nonce = deriveTokenNonce(debitRef)`
   (`server/src/common/token.ts`). `TokenPayload` gains `debitRef`. Each signer verifies the token equals exactly
   `buildTokenPayload(debit)` (new round-2 check → `400 TOKEN_NOT_DEBIT_BOUND`) and that `debit.meterId`/`debit.amountKwh`
   match the request (folded into the `401 WALL_1_MISMATCH` check). Result: exactly one valid token per debit; a
   compromised coordinator cannot mint a second distinct token. The meter also dedups on `debitRef` (belt-and-braces).
2. **Pre-flight quorum check** before the debit (fail fast at Wall 2, no money moved); the post-debit below-threshold
   path stays as the FR-21 race backstop.
3. **Reconciliation counts distinct debitRefs / tx hashes** so a same-debit double-mint would surface as Δ≠0 (FR-D3).
4. **Meter pre-verification before the XRPL write** — no orphan on-chain record for a token the meter would reject.
5. **Signer sessions deleted on every terminal round-2 outcome** (refuse / check-failure), not only on success.
6. **FR-14 anti-spam**: per-merchant sliding-window rate limit on `POST /api/requests` (20 / 10 s → `429 RATE_LIMITED`).
7. **Dashboard**: dropped the redundant reconnect fetch that could revert fresher WS state; alert badge tracks unseen
   by id (works past the 100-alert cap); demo outcome label says `ABANDONED …` for `REJECTED_ABANDONED`.
