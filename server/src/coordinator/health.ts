/**
 * Health polling (bank + signers, every 3s from index.ts) and demo-control
 * proxies to the bank/signer admin endpoints. Everything here degrades
 * gracefully when a peer is down (FR-D2): unreachable → recorded as down/offline.
 */
import { BANK_URL, SIGNERS, signerUrl } from '../common/config.js';
import type { BankMode, SignerHealth, SignerId } from '../common/types.js';
import { tryFetchJson, type HttpResult } from './http.js';
import * as store from './store.js';

export async function pollBankHealth(): Promise<void> {
  const r = await tryFetchJson(`${BANK_URL}/api/health`, {}, 1500);
  if (r?.ok && r.body?.up === true) store.updateBankHealth(true, r.body.mode as BankMode);
  else store.updateBankHealth(false);
}

export async function pollSignerHealth(): Promise<SignerHealth[]> {
  const healths = await Promise.all(
    SIGNERS.map(async (s): Promise<SignerHealth> => {
      const r = await tryFetchJson(`${signerUrl(s)}/api/health`, {}, 1500);
      if (r?.ok && r.body?.signerId === s.signerId) {
        return { ...(r.body as SignerHealth), revoked: false }; // governance overlay applied in store
      }
      return store.offlineSignerHealth(s);
    }),
  );
  store.updateSignerHealths(healths);
  return healths;
}

export async function pollAllHealth(): Promise<void> {
  await Promise.all([pollBankHealth(), pollSignerHealth()]);
}

/** Proxy to the bank admin mode endpoint, then refresh bank status. */
export async function setBankMode(mode: BankMode): Promise<HttpResult | null> {
  const r = await tryFetchJson(`${BANK_URL}/api/admin/mode`, { method: 'POST', body: JSON.stringify({ mode }) }, 3000);
  await pollBankHealth();
  return r;
}

/** Proxy to a signer's admin online toggle, then refresh consortium status. */
export async function setSignerOnline(signerId: SignerId, online: boolean): Promise<HttpResult | null> {
  const signer = SIGNERS.find((s) => s.signerId === signerId);
  if (!signer) return null;
  const r = await tryFetchJson(
    `${signerUrl(signer)}/api/admin/online`,
    { method: 'POST', body: JSON.stringify({ online }) },
    3000,
  );
  await pollSignerHealth();
  return r;
}
