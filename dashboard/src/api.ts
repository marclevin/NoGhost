/** Thin fetch helpers — all calls go through the Vite proxy via relative /api paths. */
import type { BankMode, SignerId } from './types';

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

async function post<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: T | null = null;
    try {
      data = (await res.json()) as T;
    } catch {
      /* non-JSON body */
    }
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err instanceof Error ? err.message : 'network error' };
  }
}

export type ScenarioKind = 'legit' | 'ghost' | 'collusion-short';

export const api = {
  scenario: (kind: ScenarioKind) =>
    post<{ requestId: string; kind: ScenarioKind }>('/api/demo/scenario', { kind }),
  bankMode: (mode: BankMode) => post<{ mode: BankMode }>('/api/demo/bank-mode', { mode }),
  signerOnline: (signerId: SignerId, online: boolean) =>
    post(`/api/demo/signers/${signerId}`, { online }),
  merchantAction: (merchantId: string, action: 'revoke' | 'reinstate') =>
    post(`/api/merchants/${merchantId}/${action}`),
  memberAction: (signerId: SignerId, action: 'revoke' | 'reinstate') =>
    post(`/api/governance/members/${signerId}/${action}`),
  submitRequest: (body: { meterId: string; amountKwh: number; merchantId: string }) =>
    post<{ requestId: string }>('/api/requests', body),
};
