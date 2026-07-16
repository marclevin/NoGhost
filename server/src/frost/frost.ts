/**
 * FROST(Ed25519, SHA-512) — RFC 9591 two-round threshold Schnorr signing.
 *
 * Properties this module delivers (the crypto heart of "Wall 2"):
 *  - t-of-n signing: any t participants can jointly produce a signature;
 *    fewer than t cannot (their partials are information-theoretically useless).
 *  - The group secret key exists only inside `trustedDealerKeygen` and is
 *    discarded before it returns — signing never reassembles it. Each signer
 *    computes its partial from its own share only.
 *  - The aggregate signature is a STANDARD Ed25519 signature: it verifies with
 *    any off-the-shelf Ed25519 verifier against the group public key. This is
 *    what lets the simulated meter verify tokens with zero knowledge of FROST.
 *
 * PoC simplification (FRD §9): key generation uses a trusted dealer (Shamir
 * split) rather than a distributed key generation ceremony.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha2';
import { randomBytes } from 'node:crypto';
import { bytesToHex, hexToBytes } from '../common/canonical.js';

const Point = ed25519.ExtendedPoint;
type Pt = typeof Point.BASE;
const G = Point.BASE;
const L = ed25519.CURVE.n; // group order

const CONTEXT = utf8('FROST-ED25519-SHA512-v1');

// ---------------------------------------------------------------------------
// scalar / byte helpers (Ed25519 convention: 32-byte little-endian scalars)
// ---------------------------------------------------------------------------

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const mod = (a: bigint, m: bigint = L): bigint => ((a % m) + m) % m;

function bytesToNumberLE(b: Uint8Array): bigint {
  let r = 0n;
  for (let i = b.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(b[i]);
  return r;
}

export function scalarToBytes(s: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = mod(s);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function scalarFromHex(hex: string): bigint {
  return mod(bytesToNumberLE(hexToBytes(hex)));
}

export const scalarToHex = (s: bigint): string => bytesToHex(scalarToBytes(s));

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let b = mod(base, m);
  let e = exp;
  let r = 1n;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

const invert = (a: bigint): bigint => modPow(a, L - 2n, L);

function randomScalar(): bigint {
  // 64 uniform bytes reduced mod L — negligible bias
  for (;;) {
    const s = mod(bytesToNumberLE(randomBytes(64)));
    if (s !== 0n) return s;
  }
}

function pointFromHex(hex: string): Pt {
  return Point.fromHex(hex);
}

const pointToHex = (p: Pt): string => bytesToHex(p.toRawBytes());

/** multiply that tolerates scalar 0 (public, non-secret scalars only) */
function mulUnsafe(p: Pt, s: bigint): Pt {
  const k = mod(s);
  return k === 0n ? Point.ZERO : p.multiplyUnsafe(k);
}

// ---------------------------------------------------------------------------
// RFC 9591 hash functions for FROST(Ed25519, SHA-512)
// ---------------------------------------------------------------------------

const hashToScalar = (...parts: Uint8Array[]): bigint => mod(bytesToNumberLE(sha512(concat(...parts))));

const H1 = (m: Uint8Array): bigint => hashToScalar(CONTEXT, utf8('rho'), m);
/** Challenge — deliberately the plain Ed25519 challenge (no context) so the final signature is RFC 8032 compatible. */
const H2 = (m: Uint8Array): bigint => mod(bytesToNumberLE(sha512(m)));
const H3 = (m: Uint8Array): bigint => hashToScalar(CONTEXT, utf8('nonce'), m);
const H4 = (m: Uint8Array): Uint8Array => sha512(concat(CONTEXT, utf8('msg'), m));
const H5 = (m: Uint8Array): Uint8Array => sha512(concat(CONTEXT, utf8('com'), m));

// ---------------------------------------------------------------------------
// public API types (everything hex-encoded so it travels over HTTP/JSON)
// ---------------------------------------------------------------------------

export interface KeyShare {
  identifier: number; // 1..n, the participant's x-coordinate
  secretShare: string; // hex scalar — PRIVATE to the participant
  verificationShare: string; // hex point — public, allows partial-sig verification
}

export interface KeygenOutput {
  groupPublicKey: string; // hex point — the ONE key meters trust
  threshold: number;
  total: number;
  shares: KeyShare[];
}

export interface Commitment {
  identifier: number;
  hiding: string; // hex point D_i
  binding: string; // hex point E_i
}

export interface Round1Output {
  /** PRIVATE nonces — keep on the signer, destroy after round 2 (never reuse). */
  nonces: { hiding: string; binding: string };
  /** Public commitments — sent to the coordinator. */
  commitment: { hiding: string; binding: string };
}

// ---------------------------------------------------------------------------
// keygen (trusted dealer — PoC simplification, FRD §9)
// ---------------------------------------------------------------------------

export function trustedDealerKeygen(t: number, n: number): KeygenOutput {
  if (t < 1 || n < t) throw new Error('invalid threshold parameters');
  // f(x) = s + a1*x + ... + a_{t-1}*x^{t-1}; share_i = f(i); group secret s = f(0)
  const coeffs: bigint[] = [];
  for (let i = 0; i < t; i++) coeffs.push(randomScalar());

  const shares: KeyShare[] = [];
  for (let id = 1; id <= n; id++) {
    const x = BigInt(id);
    let acc = 0n;
    let xp = 1n;
    for (const c of coeffs) {
      acc = mod(acc + c * xp);
      xp = mod(xp * x);
    }
    shares.push({
      identifier: id,
      secretShare: scalarToHex(acc),
      verificationShare: pointToHex(G.multiply(acc)),
    });
  }
  const groupPublicKey = pointToHex(G.multiply(coeffs[0]));
  // coeffs (including the group secret, coeffs[0]) go out of scope here and are
  // never persisted — after this returns, the full key exists nowhere.
  return { groupPublicKey, threshold: t, total: n, shares };
}

// ---------------------------------------------------------------------------
// round 1 — commit
// ---------------------------------------------------------------------------

export function round1(secretShareHex: string): Round1Output {
  const sk = scalarFromHex(secretShareHex);
  const gen = (): bigint => {
    for (;;) {
      const s = H3(concat(randomBytes(32), scalarToBytes(sk)));
      if (s !== 0n) return s;
    }
  };
  const d = gen();
  const e = gen();
  return {
    nonces: { hiding: scalarToHex(d), binding: scalarToHex(e) },
    commitment: { hiding: pointToHex(G.multiply(d)), binding: pointToHex(G.multiply(e)) },
  };
}

// ---------------------------------------------------------------------------
// shared derivations (binding factors, group commitment, challenge, lambda)
// ---------------------------------------------------------------------------

function sortedCommitments(commitments: Commitment[]): Commitment[] {
  const sorted = [...commitments].sort((a, b) => a.identifier - b.identifier);
  const ids = new Set(sorted.map((c) => c.identifier));
  if (ids.size !== sorted.length) throw new Error('duplicate identifiers in commitment list');
  return sorted;
}

function bindingFactors(groupPublicKeyHex: string, commitments: Commitment[], message: Uint8Array): Map<number, bigint> {
  const sorted = sortedCommitments(commitments);
  const encoded = concat(
    ...sorted.map((c) => concat(scalarToBytes(BigInt(c.identifier)), hexToBytes(c.hiding), hexToBytes(c.binding))),
  );
  const prefix = concat(hexToBytes(groupPublicKeyHex), H4(message), H5(encoded));
  const out = new Map<number, bigint>();
  for (const c of sorted) out.set(c.identifier, H1(concat(prefix, scalarToBytes(BigInt(c.identifier)))));
  return out;
}

function groupCommitment(commitments: Commitment[], rho: Map<number, bigint>): Pt {
  let R = Point.ZERO;
  for (const c of sortedCommitments(commitments)) {
    R = R.add(pointFromHex(c.hiding)).add(mulUnsafe(pointFromHex(c.binding), rho.get(c.identifier)!));
  }
  return R;
}

function challenge(R: Pt, groupPublicKeyHex: string, message: Uint8Array): bigint {
  return H2(concat(R.toRawBytes(), hexToBytes(groupPublicKeyHex), message));
}

/** Lagrange coefficient for participant i over the participant set (evaluated at 0). */
export function lagrangeCoefficient(identifier: number, participantIdentifiers: number[]): bigint {
  const i = BigInt(identifier);
  let num = 1n;
  let den = 1n;
  for (const jn of participantIdentifiers) {
    const j = BigInt(jn);
    if (j === i) continue;
    num = mod(num * j);
    den = mod(den * (j - i));
  }
  if (den === 0n) throw new Error('duplicate participant identifiers');
  return mod(num * invert(den));
}

// ---------------------------------------------------------------------------
// round 2 — sign (runs ON the signer, using only its own share + nonces)
// ---------------------------------------------------------------------------

export interface Round2Params {
  identifier: number;
  secretShare: string; // hex
  nonces: { hiding: string; binding: string }; // from this signer's round 1
  message: Uint8Array;
  commitments: Commitment[]; // full participant commitment list (incl. own)
  groupPublicKey: string; // hex
}

export function round2Sign(p: Round2Params): { zi: string } {
  const sorted = sortedCommitments(p.commitments);
  const participants = sorted.map((c) => c.identifier);
  if (!participants.includes(p.identifier)) throw new Error('own identifier missing from commitment list');

  const own = sorted.find((c) => c.identifier === p.identifier)!;
  const d = scalarFromHex(p.nonces.hiding);
  const e = scalarFromHex(p.nonces.binding);
  // integrity: the coordinator-supplied commitment for us must match our nonces
  if (pointToHex(G.multiply(d)) !== own.hiding || pointToHex(G.multiply(e)) !== own.binding) {
    throw new Error('commitment list does not match local nonces');
  }

  const rho = bindingFactors(p.groupPublicKey, sorted, p.message);
  const R = groupCommitment(sorted, rho);
  const c = challenge(R, p.groupPublicKey, p.message);
  const lambda = lagrangeCoefficient(p.identifier, participants);
  const sk = scalarFromHex(p.secretShare);

  const zi = mod(d + e * rho.get(p.identifier)! + lambda * sk * c);
  return { zi: scalarToHex(zi) };
}

// ---------------------------------------------------------------------------
// aggregate + verification (coordinator side — uses public values only)
// ---------------------------------------------------------------------------

export interface SignatureShare {
  identifier: number;
  zi: string; // hex scalar
}

/** Verify one participant's partial signature (attribution of misbehaviour, RFC 9591 §5.3). */
export function verifySignatureShare(
  share: SignatureShare,
  verificationShareHex: string,
  commitments: Commitment[],
  groupPublicKeyHex: string,
  message: Uint8Array,
): boolean {
  const sorted = sortedCommitments(commitments);
  const participants = sorted.map((c) => c.identifier);
  const own = sorted.find((c) => c.identifier === share.identifier);
  if (!own) return false;

  const rho = bindingFactors(groupPublicKeyHex, sorted, message);
  const R = groupCommitment(sorted, rho);
  const c = challenge(R, groupPublicKeyHex, message);
  const lambda = lagrangeCoefficient(share.identifier, participants);

  const lhs = mulUnsafe(G, scalarFromHex(share.zi));
  const rhs = pointFromHex(own.hiding)
    .add(mulUnsafe(pointFromHex(own.binding), rho.get(share.identifier)!))
    .add(mulUnsafe(pointFromHex(verificationShareHex), mod(c * lambda)));
  return lhs.equals(rhs);
}

/** Combine partials into a standard 64-byte Ed25519 signature (R || z). */
export function aggregate(
  commitments: Commitment[],
  shares: SignatureShare[],
  groupPublicKeyHex: string,
  message: Uint8Array,
): { signature: string } {
  const sorted = sortedCommitments(commitments);
  if (shares.length !== sorted.length) throw new Error('share count must match commitment count');
  const rho = bindingFactors(groupPublicKeyHex, sorted, message);
  const R = groupCommitment(sorted, rho);
  let z = 0n;
  for (const s of shares) z = mod(z + scalarFromHex(s.zi));
  return { signature: bytesToHex(concat(R.toRawBytes(), scalarToBytes(z))) };
}

/** Standard Ed25519 verification — exactly what the simulated meter runs. */
export function verifySignature(signatureHex: string, message: Uint8Array, groupPublicKeyHex: string): boolean {
  try {
    return ed25519.verify(hexToBytes(signatureHex), message, hexToBytes(groupPublicKeyHex));
  } catch {
    return false;
  }
}
