# NoGhost: Blockchain Architecture

How the XRP Ledger is used in this system. This document covers only the chain layer: which accounts exist, which transactions are submitted, who submits them, what the payloads contain, what it costs, and what the risks are.

**Network:** XRPL Testnet, `wss://s.altnet.rippletest.net:51233`
**Explorer:** `https://testnet.xrpl.org`
**Smart contracts:** none. Everything uses native XRPL features (Payments, AccountSet, SignerListSet, Memos, Multisign). There is no Hooks module, no EVM sidechain, no custom token.

---

## 1. The one-paragraph version

Three independent organizations form a consortium. Each holds its own XRPL account. A fourth XRPL account, the **authority account**, acts as the consortium's shared on-chain ledger: every request, every approval, and every final receipt routes through it. The authority account's master key is permanently disabled and it carries a 2-of-3 SignerList, so no single party, including our own coordinator service, can produce a receipt alone. The XRP Ledger's own validators enforce that quorum. Each vending request produces five transactions: one encrypted publish, three independent member approvals, and one 2-of-3 multisigned receipt.

---

## 2. Accounts and key custody

Four XRPL accounts are created once by the setup ceremony (`server/src/scripts/setup-xrpl.ts`, run via `npm run setup:xrpl`). All four are funded from the testnet faucet.

| Role | Address (current testnet deployment) | Who controls it | What it signs |
| --- | --- | --- | --- |
| **Authority** | `rJZ4oTpbfeT1pJHv1Kvuhkvz4rtf8PSJVQ` | **Nobody.** Master key disabled. | Receipts only, and only via 2-of-3 multisign |
| Member: National Utility | `r35MHt3CKvTuQhyQJtMd9s6hfVhvGvVdwY` | The `utility` signer process | Its own approvals, its own receipt fragments |
| Member: City A Metro | `rDkCHQfK7W27bqa4DibhmfWpQaJoBhEWLw` | The `city-a` signer process | Its own approvals, its own receipt fragments |
| Member: City B Metro | `r4DKeG5D3temXXr62N6S7ioHTHwWQeLXwb` | The `city-b` signer process | Its own approvals, its own receipt fragments |
| Publisher | from `.env` `XRP_WALLET_ADDRESS` | The coordinator service | The encrypted request publish only |

### Key custody rules

- **The authority seed is never persisted.** It exists only inside the setup script's process memory, and its master key is disabled before that process exits. After setup completes, the private key that could unilaterally control the authority account does not exist on any disk, anywhere. This is deliberate and irreversible.
- **Each member seed is written only to that member's own file**, `server/keys/xrpl-member-<id>.json`. A signer process loads exactly one wallet, its own (`server/src/signer/index.ts:67`). No process loads more than one member key.
- **The coordinator never holds a member key.** It holds only the publisher seed, which can do nothing except post a Payment carrying a memo.
- `server/keys/` and `.env` are gitignored and confirmed untracked in git.

### Public manifest

`server/keys/xrpl-consortium.json` is the public directory that maps roles to addresses. Every service reads it to know who is who:

```json
{
  "network": "wss://s.altnet.rippletest.net:51233",
  "authority": "rJZ4oTpbfeT1pJHv1Kvuhkvz4rtf8PSJVQ",
  "quorum": 2,
  "masterKeyDisabled": true,
  "members": {
    "utility": "r35MHt3CKvTuQhyQJtMd9s6hfVhvGvVdwY",
    "city-a":  "rDkCHQfK7W27bqa4DibhmfWpQaJoBhEWLw",
    "city-b":  "r4DKeG5D3temXXr62N6S7ioHTHwWQeLXwb"
  }
}
```

This is what makes approvals attributable. When the system reads an approval off the ledger, it maps the transaction's `Account` field back to a member identity through this manifest. A member cannot post an approval on behalf of another member, because it does not hold the other member's key.

---

## 3. How the quorum key is made

There are **two separate 2-of-3 schemes** in this system, held by the same three organizations but built from completely different key material. Do not conflate them.

### 3.1 The on-chain quorum (XRPL multisign)

This is not a threshold cryptography scheme. It is a native XRPL account feature. Each member keeps an ordinary, independent XRPL keypair. The ledger is told to accept transactions on the authority account only when signatures from enough of those keypairs are present.

Built in three steps during setup:

**Step 1: attach a SignerList to the authority account.**

```ts
// server/src/scripts/setup-xrpl.ts:84-93
const entries = members
  .map((m) => ({ account: m.wallet.address }))
  .sort((a, b) => Buffer.compare(decodeAccountID(a.account), decodeAccountID(b.account)))
  .map((m) => ({ SignerEntry: { Account: m.account, SignerWeight: 1 } }));

await submit(client, authority, {
  TransactionType: 'SignerListSet',
  Account: authority.address,
  SignerQuorum: XRPL_MULTISIGN_QUORUM,   // 2
  SignerEntries: entries,                 // three members, weight 1 each
}, 'SignerListSet (2-of-3)');
```

Each member gets `SignerWeight: 1` and the quorum is `2`, so any two of the three suffice and all three are equal. Entries must be sorted by decoded account ID, which is an XRPL protocol requirement, not a stylistic choice.

**Step 2: prove multisign works before locking the door.** A no-op `AccountSet` is multisigned and submitted. If this failed, setup would abort with the master key still live and the account still recoverable.

**Step 3: disable the master key.**

```ts
// server/src/scripts/setup-xrpl.ts:106
{ TransactionType: 'AccountSet', Account: authority.address, SetFlag: 4 /* asfDisableMaster */ }
```

Then the multisign self-test runs **again**, post-disable, to confirm the account is still usable. From this point on, the only way any transaction can originate from the authority account is with two valid member signatures. That is enforced by XRPL consensus, not by our code.

The quorum value is derived from a single constant so the on-chain and off-chain thresholds can never drift apart:

```ts
// server/src/common/config.ts:35, 57-58
export const THRESHOLD = { t: 2, n: 3 } as const;
/** On-chain consortium threshold, matches the FROST threshold (2-of-3). */
export const XRPL_MULTISIGN_QUORUM = THRESHOLD.t;
```

### 3.2 The off-chain quorum (FROST threshold signatures)

Separate and unrelated key material. FROST(Ed25519, SHA-512) is used to produce the **vending token**, and it never touches the chain. It is included here only so the distinction is clear.

- The key is split by a trusted dealer at setup into three Shamir shares over the Ed25519 scalar field. The group secret is discarded on generation and never reassembled.
- Two of three shares produce a standard RFC 8032 Ed25519 signature over the token payload. A stock verifier validates it with no knowledge of FROST.
- The token itself is **never published to the chain**. Only `sha256(token)` appears, inside the receipt.

**Summary of the distinction:**

| | FROST quorum | XRPL quorum |
| --- | --- | --- |
| Key material | Ed25519 Shamir shares | Independent XRPL keypairs |
| Where held | `server/keys/signer-*.json` | `server/keys/xrpl-member-*.json` |
| Enforced by | Our signer code | XRPL validators |
| Signs | The vending token | Transactions on the authority account |
| Visible on chain | No | Yes |

Compromising one does not compromise the other.

---

## 4. Governance assignment

Membership is assigned at setup time and is fixed for the lifetime of the deployment. There is no on-chain enrollment, voting, or rotation mechanism in this build.

- **Adding or removing a member on chain** would require a new `SignerListSet` on the authority account, which itself needs 2-of-3 approval from the current members. The ledger enforces this, so no unilateral membership change is possible. This path is not implemented; it is the natural upgrade route.
- **Off-chain suspension** does exist. The coordinator can mark a member revoked, which excludes it from ceremonies. This is an operational control only. It has no on-chain effect: a revoked member's XRPL key still satisfies the SignerList. Treat this as a soft control, not a security boundary.
- **Refusal is a first-class outcome.** Any member can independently post a `REJECT` attestation for policy reasons, and that refusal is permanently recorded on the public ledger with that member's signature on it. This is the accountability property the design is built around.

---

## 5. The flow: Merchant to Bank to Chain to Token

Five XRPL transactions per successful request. Steps that touch the chain are marked.

```
Merchant (POS request)
   |
   v
[1] Policy gate            off-chain    merchant known and not revoked
   |
[2] Quorum pre-flight      off-chain    at least 2 members reachable, else stop before taking money
   |
   v
Bank (Wall 1)
   |
[3] Debit                  off-chain    bank signs {debitRef, requestId, meterId, amountKwh, amount, currency, confirmedAt}
   |                                    with its own Ed25519 key. Coordinator verifies against a pinned public key.
   v
XRP LEDGER
   |
[4] PUBLISH        >>> TX 1     Payment, coordinator publisher -> authority, encrypted request in memo
   |
[5] APPROVALS      >>> TX 2,3,4 Payment, each member -> authority, that member's own signed verdict
   |                            Coordinator then reads the approval set BACK off the ledger.
   |                            Fewer than 2 APPROVE, the request is abandoned and the debit reversed.
   v
Signers (Wall 2)
   |
[6] FROST ceremony         off-chain    each signer independently re-reads the ledger and refuses
   |                                    to release its partial signature without on-chain quorum
   |
[7] Token produced         off-chain    2-of-3 aggregate Ed25519 signature over the token payload
   |
   v
XRP LEDGER
   |
[8] RECEIPT        >>> TX 5     AccountSet on authority, 2-of-3 MULTISIGNED, hashes only
   |
   v
Meter (token delivered)
```

### Step 4: publish the request

```ts
// server/src/common/chain.ts:183-194
export async function publishRequest(publisher: Wallet, requestHash: string, plaintext: unknown) {
  const auth = loadManifest().authority;
  const packed = packRequest(requestHash, plaintext);
  const { hash, ledgerIndex } = await submitTx(c, publisher, {
    TransactionType: 'Payment',
    Account: publisher.address,
    Destination: auth,
    Amount: '1',                                    // 1 drop, the minimum carrier
    Memos: [rawMemo('noghost/request', packed)],
  }, 'publishRequest');
  return { requestHash, txHash: hash, ledgerIndex };
}
```

A Payment is used purely as a memo carrier. The 1 drop transfer is economically meaningless and exists because a Payment requires an amount.

The memo payload is **encrypted**. The public ledger carries ciphertext, not customer data:

```
[32 bytes requestHash][12 bytes IV][16 bytes GCM tag][AES-256-GCM(gzip(JSON({request, debit})))]
```

hex encoded, uppercased. Gzip is what makes a full request plus debit confirmation, including a 64 byte bank signature, fit comfortably in one memo. The AES-256-GCM key is a shared consortium key generated at setup and distributed to all three members.

```
MemoType   = hex("noghost/request")
MemoFormat = hex("application/octet-stream")
MemoData   = the packed binary blob above, as hex
```

### Step 5: member approvals

This is the part that makes the consensus real rather than asserted. **Each member reads the request off the ledger itself and does not trust the coordinator's account of it** (`server/src/signer/index.ts:169-223`):

1. Fetch the transaction from the ledger by hash, decrypt the memo. AES-GCM's auth tag means any tampering fails the decrypt outright.
2. Check `hash(decrypted request) === requestHash`. Mismatch, reject.
3. Independently verify the bank's Ed25519 signature against its own pinned copy of the bank public key.
4. Independently recompute the price and check every field of the debit against the request.
5. Post its **own** transaction, signed with its **own** key:

```ts
// server/src/common/chain.ts:217-227
{
  TransactionType: 'Payment',
  Account: member.address,
  Destination: auth,
  Amount: '1',
  Memos: [memo('noghost/approval', {
    v: 1, requestHash, signerId, verdict, reason?   // verdict: 'APPROVE' | 'REJECT'
  })],
}
```

```
MemoType   = hex("noghost/approval")
MemoFormat = hex("application/json")
MemoData   = hex(JSON)                              // plaintext, deliberately auditable
```

Approvals are plaintext by design. They contain no customer data, only a hash, a member identity, and a verdict, and their public readability is the point.

The coordinator then reads the authoritative approval set **back off the ledger** rather than trusting its own record of the HTTP responses:

```ts
// server/src/common/chain.ts:243
const res = await c.request({
  command: 'account_tx', account: auth, limit: 200,
  ledger_index_min: -1, ledger_index_max: -1,
});
```

Transactions are matched to members by mapping `tx.Account` through the manifest. Fewer than two `APPROVE` verdicts and the request is abandoned and the bank debit reversed.

### Step 8: the multisigned receipt

Three stages across two service boundaries.

**Coordinator prepares once**, so all members sign a byte-identical transaction:

```ts
// server/src/common/chain.ts:279-291
const tx = {
  TransactionType: 'AccountSet',
  Account: auth,
  Memos: [memo('noghost/receipt', { v: 1, ...fields })],
};
const prepared = await c.autofill(tx, quorum);   // 2nd arg inflates the fee for multisign
prepared.SigningPubKey = '';                      // required for multisign
return prepared;
```

An `AccountSet` with no flags is a deliberate no-op. It changes nothing about the account and exists purely to anchor the memo, at lower cost than a Payment and with no value transfer.

**Each member returns a fragment:**

```ts
// server/src/common/chain.ts:294-296
export function signReceiptFragment(member: Wallet, prepared: SubmittableTransaction): string {
  return member.sign(prepared, true).tx_blob;      // multisign = true
}
```

**Coordinator combines and submits:**

```ts
// server/src/common/chain.ts:299-307
const combined = multisign(fragments);
const res = await c.submitAndWait(combined);
```

The receipt memo contains **hashes only**. No customer data, no token, no bank reference in the clear:

```json
{
  "v": 1,
  "requestHash":  "sha256 of the canonical request",
  "debitRefHash": "sha256 of the bank debit reference",
  "tokenHash":    "sha256 of the issued token",
  "signerSet":    ["utility", "city-a"],
  "ts":           "ISO timestamp"
}
```

### What ends up on chain, and what does not

| On chain | Not on chain |
| --- | --- |
| Encrypted request and debit (ciphertext) | The vending token itself |
| Request hash | Any FROST key material |
| Per-member APPROVE or REJECT with reason | Customer or meter identity in the clear |
| Which two members signed the receipt | The bank debit reference in the clear |
| Hashes of the debit reference and the token | Merchant name |

---

## 6. Transaction reference

| # | Type | From | To | Amount | Memo kind | Format | Signing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Setup | `SignerListSet` | authority | n/a | n/a | none | n/a | single (master key, pre-disable) |
| Setup | `AccountSet` `SetFlag: 4` | authority | n/a | n/a | none | n/a | single (master key, final use) |
| 1 | `Payment` | coordinator publisher | authority | 1 drop | `noghost/request` | octet-stream, encrypted | single |
| 2-4 | `Payment` | each member | authority | 1 drop | `noghost/approval` | JSON, plaintext | single, per member |
| 5 | `AccountSet` (no-op) | authority | n/a | none | `noghost/receipt` | JSON, hashes only | **2-of-3 multisign** |

Ledger reads used: `tx` (fetch one published request by hash), `account_tx` (reconstruct the approval set), `account_info` (balance checks in the smoke script). No `subscribe` streams.

---

## 7. Cost

XRPL fees are burned, not paid to a validator. All figures below are in drops. **1 XRP = 1,000,000 drops.**

### Per request (the steady-state cost)

| Transaction | Count | Fee each | Fee subtotal | Amount transferred |
| --- | --- | --- | --- | --- |
| Publish Payment | 1 | ~10 drops | 10 | 1 drop |
| Member approvals | 3 | ~10 drops | 30 | 3 drops |
| Multisigned receipt | 1 | ~30 drops | 30 | 0 |
| **Total** | **5** | | **~70 drops** | **4 drops** |

**~70 drops burned, or 0.00007 XRP per vending request.** At any plausible XRP price this is a small fraction of one US cent. The 4 drops transferred are not burned; they accumulate in the authority account.

Two things to understand about these numbers:

- **10 drops is the reference fee, not a fixed price.** XRPL uses open-ledger fee escalation: when a ledger fills, the required fee rises sharply and falls back once congestion clears. `autofill` queries the network for the current fee at submission time, so real cost tracks load. Under sustained congestion the per-request cost could rise by orders of magnitude, though it remains small in absolute terms.
- **Multisign costs more, by design.** The fee scales with the number of signatures: `base_fee x (1 + N)`. With 2 signatures that is roughly triple a normal transaction. `autofill(tx, quorum)` is what accounts for this.

### One-time and standing costs

- **Account reserves.** Each of the four accounts must hold a base reserve, currently 1 XRP on mainnet, which is locked, not spent. The authority's SignerList is one owner object, adding a 0.2 XRP owner reserve. Total locked across the deployment is roughly 4.2 XRP.
- **Setup transactions.** Six transactions: `SignerListSet`, two multisign self-tests, the master key disable, plus faucet funding. Negligible.
- **Testnet is free.** All accounts are faucet-funded. There is no real economic cost in the current deployment.

### Cost scaling note

Cost is linear in requests and linear in consortium size, since every member posts its own approval. A 5-member consortium would be 7 transactions per request instead of 5. Nothing here batches or amortizes across requests, which is a reasonable trade for a system whose entire value proposition is per-request non-repudiable attribution.

---

## 8. Risk register

### Deployment posture

**This is XRPL Testnet.** Faucet-funded accounts, no real value at stake, and testnet state can be reset or pruned by the network operators without notice. Nothing here has been exercised under mainnet conditions.

### Chain-specific risks

**1. Master key disable is irreversible.** If two of the three member seeds are lost, the authority account is permanently and unrecoverably frozen. No transaction can ever originate from it again. This is the intended security property and it is also the single largest operational hazard. Member key backup and recovery procedure is a hard prerequisite for any real deployment.

**2. Public ledger data is permanent.** Nothing on XRPL can be deleted or amended. The design mitigates this by publishing only ciphertext for the request and only hashes in the receipt, but the mitigation is cryptographic, not legal. Under a right-to-erasure regime (GDPR, POPIA) the position is that no personal data was ever written in a recoverable form. That argument depends entirely on the encryption holding.

**3. Harvest now, decrypt later.** The request ciphertext is public and permanent. The AES-256-GCM key is a **single shared key held by all three members**. Compromise of any one member's key file retroactively decrypts every request ever published, going back to genesis. This is the sharpest confidentiality risk in the design. Per-request key derivation or per-member envelope encryption would remove the single point of failure.

**4. Metadata leaks even when payloads do not.** Transaction timing, frequency, counterparty graph, and approval-versus-rejection ratios are all public and unencrypted. An observer learns volume, tempo, and which members reject most often, without breaking any encryption.

**5. The approval scan has a fixed window.** `readApprovals` issues `account_tx` with `limit: 200` and no pagination (`server/src/common/chain.ts:243`). Every request adds about five transactions to the authority account, so after roughly forty requests the oldest approvals fall out of the scan window. Acceptable for a demonstration, but this would silently degrade a long-running instance. Pagination via `marker` is the fix.

**6. Receipt fragments are signed without inspecting the transaction.** The `/api/consensus/sign-receipt` endpoint (`server/src/signer/index.ts:237-264`) verifies only that the quoted `requestHash` reached on-chain quorum. It does not parse or validate `body.prepared`. A compromised coordinator could quote one legitimately approved `requestHash` and obtain two member signatures over an entirely unrelated transaction on the authority account. Contrast this with `/api/consensus/validate`, which is rigorously independent. The fix is for each member to re-derive the expected receipt transaction locally and compare, or at minimum to parse the memo and confirm the `requestHash` matches. **This is a known open gap.**

**7. Sequence number races.** Submissions are serialized per publisher account by an in-process promise queue (`chain.ts:76-88`), which prevents sequence collisions within one process. Note that `submitReceipt` bypasses this queue. Two coordinator instances sharing one publisher seed would collide; the design assumes a single coordinator.

**8. Availability coupling.** Every request requires five confirmed transactions. XRPL outage, WebSocket disruption, or severe fee escalation stalls the pipeline. The system fails closed, abandoning the request and reversing the bank debit rather than issuing a token, which is the correct direction to fail, but availability is genuinely coupled to the ledger.

**9. Reserve exhaustion.** Member accounts pay fees on every approval. Without balance monitoring and top-up, a member silently stops being able to attest, and the consortium quietly drops to 2-of-3 with no margin.

### Risks explicitly avoided

- **No smart contract risk.** Native XRPL transaction types only. No contract code to exploit, no upgrade proxy, no reentrancy surface, no custom token economics.
- **No key concentration at the authority.** The authority private key does not exist anywhere after setup.
- **No single-party issuance.** Both the token (FROST 2-of-3) and the receipt (XRPL 2-of-3) require two independent organizations. The coordinator is a router, not an authority: it cannot fabricate either one.
- **No plaintext customer data on a public ledger.**

---

## 9. Reproducing the setup

```bash
npm run setup:xrpl
```

Creates and funds four testnet accounts, attaches the 2-of-3 SignerList, self-tests multisign, disables the authority master key, self-tests multisign again, and writes:

| File | Contents | Sensitivity |
| --- | --- | --- |
| `server/keys/xrpl-consortium.json` | addresses, quorum, network | public |
| `server/keys/xrpl-member-<id>.json` | that member's XRPL seed | **secret** |
| `server/keys/consortium-enc.json` | shared AES-256-GCM request key | **secret** |

The authority seed is intentionally not among them.

---

## 10. Source map

| Concern | File |
| --- | --- |
| All chain primitives | `server/src/common/chain.ts` |
| One-time setup ceremony | `server/src/scripts/setup-xrpl.ts` |
| Addresses, quorum, endpoints | `server/src/common/config.ts` |
| Member validation and attestation | `server/src/signer/index.ts:169-264` |
| Pipeline orchestration | `server/src/coordinator/pipeline.ts` |
| Connectivity smoke test | `server/src/scripts/xrpl-smoke.ts` |
