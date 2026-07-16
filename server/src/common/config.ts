/**
 * Shared static configuration: ports, signer registry, pricing, key paths.
 * Loads the project-root .env (XRP_WALLET_ADDRESS / XRP_WALLET_SECRET).
 */
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import dotenv from 'dotenv';
import type { SignerId } from './types.js';

const here = dirname(fileURLToPath(import.meta.url)); // server/src/common
export const SERVER_ROOT = resolve(here, '..', '..'); // server/
export const PROJECT_ROOT = resolve(SERVER_ROOT, '..'); // repo root

dotenv.config({ path: resolve(PROJECT_ROOT, '.env') });

export const PORTS = {
  coordinator: 4000,
  bank: 4100,
} as const;

export interface SignerInfo {
  signerId: SignerId;
  name: string;
  org: string;
  identifier: number; // FROST participant identifier
  port: number;
}

export const SIGNERS: SignerInfo[] = [
  { signerId: 'utility', name: 'National Utility', org: 'Utility', identifier: 1, port: 4201 },
  { signerId: 'city-a', name: 'City A Metro', org: 'Municipality A', identifier: 2, port: 4202 },
  { signerId: 'city-b', name: 'City B Metro', org: 'Municipality B', identifier: 3, port: 4203 },
];

export const THRESHOLD = { t: 2, n: 3 } as const;

export const RATE_ZAR_PER_KWH = 2.5;
export const CURRENCY = 'ZAR';

/** Price a request the way both the coordinator AND each signer must (FR-8 amount check). */
export function priceZar(amountKwh: number): number {
  return Math.round(amountKwh * RATE_ZAR_PER_KWH * 100) / 100;
}

export const BANK_URL = process.env.BANK_URL ?? `http://localhost:${PORTS.bank}`;
export const COORDINATOR_URL = process.env.COORDINATOR_URL ?? `http://localhost:${PORTS.coordinator}`;
export const signerUrl = (s: SignerInfo) => `http://localhost:${s.port}`;

export const KEYS_DIR = resolve(SERVER_ROOT, 'keys');

export const XRPL_WSS = process.env.XRPL_WSS ?? 'wss://s.altnet.rippletest.net:51233';
export const XRP_WALLET_ADDRESS = process.env.XRP_WALLET_ADDRESS ?? '';
export const XRP_WALLET_SECRET = process.env.XRP_WALLET_SECRET ?? '';
export const XRPL_EXPLORER_TX = (hash: string) => `https://testnet.xrpl.org/transactions/${hash}`;
export const XRPL_EXPLORER_ACCOUNT = (addr: string) => `https://testnet.xrpl.org/accounts/${addr}`;

/** On-chain consortium threshold — matches the FROST threshold (2-of-3). */
export const XRPL_MULTISIGN_QUORUM = THRESHOLD.t;

// Consortium on-chain key material (created by scripts/setup-xrpl.ts).
export const CONSORTIUM_MANIFEST = resolve(KEYS_DIR, 'xrpl-consortium.json');
export const CONSORTIUM_ENC_KEY_FILE = resolve(KEYS_DIR, 'consortium-enc.json');
export const xrplMemberKeyFile = (signerId: SignerId) => resolve(KEYS_DIR, `xrpl-member-${signerId}.json`);
