/**
 * Live state store: WebSocket → reducer applying WsEvent to Snapshot,
 * reconnect with exponential backoff, and a 2s GET /api/state polling
 * fallback whenever the socket is down (robustness, FR-D2).
 */
import { useEffect, useReducer, type Dispatch } from 'react';
import type { Alert, PipelineRecord, Snapshot, WsEvent } from './types';

export type ConnState = 'connecting' | 'live' | 'polling' | 'offline';

export interface StoreState {
  snapshot: Snapshot | null;
  conn: ConnState;
  /** transient toast queue (subset of alerts) */
  toasts: Alert[];
}

export type StoreAction =
  | { type: 'snapshot'; state: Snapshot }
  | { type: 'ws'; event: WsEvent }
  | { type: 'conn'; conn: ConnState }
  | { type: 'toast.dismiss'; id: string };

const REQUEST_CAP = 200;
const ALERT_CAP = 100;
const TOAST_CAP = 4;

function upsertRequest(list: PipelineRecord[], record: PipelineRecord): PipelineRecord[] {
  const i = list.findIndex((r) => r.request.requestId === record.request.requestId);
  if (i === -1) return [record, ...list].slice(0, REQUEST_CAP);
  const next = list.slice();
  next[i] = record;
  return next;
}

function pushToast(toasts: Alert[], alert: Alert): Alert[] {
  if (toasts.some((t) => t.id === alert.id)) return toasts;
  return [alert, ...toasts].slice(0, TOAST_CAP);
}

function applySnapshot(state: StoreState, snap: Snapshot): StoreState {
  // When resyncing (poll or reconnect), surface any genuinely-new warning/critical
  // alerts as toasts so nothing is missed while the socket was down.
  let toasts = state.toasts;
  if (state.snapshot) {
    const known = new Set(state.snapshot.alerts.map((a) => a.id));
    const fresh = snap.alerts.filter((a) => !known.has(a.id) && a.severity !== 'info');
    for (const a of fresh.slice(0, 3).reverse()) toasts = pushToast(toasts, a);
  }
  return { ...state, snapshot: snap, toasts };
}

function reducer(state: StoreState, action: StoreAction): StoreState {
  switch (action.type) {
    case 'conn':
      return state.conn === action.conn ? state : { ...state, conn: action.conn };
    case 'snapshot':
      return applySnapshot(state, action.state);
    case 'toast.dismiss':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case 'ws': {
      const ev = action.event;
      if (ev.type === 'hello') return applySnapshot(state, ev.state);
      const snap = state.snapshot;
      if (!snap) return state; // ignore incremental events before first snapshot
      switch (ev.type) {
        case 'request.updated':
          return { ...state, snapshot: { ...snap, requests: upsertRequest(snap.requests, ev.record) } };
        case 'bank.status':
          return { ...state, snapshot: { ...snap, bank: ev.bank } };
        case 'consortium.status':
          return { ...state, snapshot: { ...snap, consortium: ev.consortium } };
        case 'reconciliation':
          return { ...state, snapshot: { ...snap, reconciliation: ev.reconciliation } };
        case 'alert': {
          const alerts = [ev.alert, ...snap.alerts.filter((a) => a.id !== ev.alert.id)].slice(0, ALERT_CAP);
          return { ...state, snapshot: { ...snap, alerts }, toasts: pushToast(state.toasts, ev.alert) };
        }
        case 'governance.updated':
          return {
            ...state,
            snapshot: {
              ...snap,
              members: ev.members,
              merchants: ev.merchants,
              governanceLog: ev.governanceLog,
            },
          };
        case 'meter.updated': {
          const i = snap.meters.findIndex((m) => m.meterId === ev.meter.meterId);
          const meters = i === -1 ? [...snap.meters, ev.meter] : snap.meters.map((m, j) => (j === i ? ev.meter : m));
          return { ...state, snapshot: { ...snap, meters } };
        }
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

const initialState: StoreState = { snapshot: null, conn: 'connecting', toasts: [] };

const POLL_MS = 2000;
const BACKOFF_MAX_MS = 15000;

export function useTwoWallsStore(): { state: StoreState; dispatch: Dispatch<StoreAction> } {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let wsOpen = false;
    let attempt = 0;
    let pollTimer: number | undefined;
    let reconnectTimer: number | undefined;

    const poll = async () => {
      try {
        const res = await fetch('/api/state');
        // Only apply the full snapshot while the socket is NOT open — a poll
        // started before onopen could resolve late and clobber fresher WS state.
        if (disposed || wsOpen) return;
        if (res.ok) {
          dispatch({ type: 'snapshot', state: (await res.json()) as Snapshot });
          dispatch({ type: 'conn', conn: 'polling' });
        } else {
          dispatch({ type: 'conn', conn: 'offline' });
        }
      } catch {
        if (!disposed && !wsOpen) dispatch({ type: 'conn', conn: 'offline' });
      }
    };

    const startPolling = () => {
      if (pollTimer !== undefined) return;
      void poll();
      pollTimer = window.setInterval(() => void poll(), POLL_MS);
    };
    const stopPolling = () => {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** Math.min(attempt, 6)) + Math.random() * 400;
      attempt += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    };

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      try {
        ws = new WebSocket(`${proto}://${location.host}/ws`);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        wsOpen = true;
        attempt = 0;
        stopPolling();
        dispatch({ type: 'conn', conn: 'live' });
        // The server always sends `{type:'hello', state}` immediately on connect,
        // which fully replaces the snapshot — so no redundant /api/state fetch is
        // needed here (it could race and revert a fresher incremental WS frame).
      };
      ws.onmessage = (e) => {
        try {
          const ev = JSON.parse(String(e.data)) as WsEvent;
          if (ev && typeof ev === 'object' && 'type' in ev) dispatch({ type: 'ws', event: ev });
        } catch {
          /* malformed frame — ignore */
        }
      };
      ws.onclose = () => {
        wsOpen = false;
        if (!disposed) {
          dispatch({ type: 'conn', conn: 'connecting' });
          startPolling();
          scheduleReconnect();
        }
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* noop */
        }
      };
    };

    startPolling(); // poll immediately until the socket is up
    connect();

    return () => {
      disposed = true;
      stopPolling();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    };
  }, []);

  return { state, dispatch };
}
