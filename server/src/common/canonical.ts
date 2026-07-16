/**
 * Canonical serialization + hashing.
 *
 * Every signature in the system (bank attestations, FROST token signatures)
 * is made over `canonicalBytes(value)` so that signer and verifier agree on
 * the exact byte string regardless of object key order.
 */
import { createHash } from 'node:crypto';

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === 'object' && (v as object).constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** Deterministic JSON: recursively sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 over the canonical JSON encoding of a value. */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}

export function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error(`invalid hex string (len=${hex.length})`);
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
