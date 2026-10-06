import type { Store } from '../db/store.ts';

export type WaState = 'open' | 'closed' | 'logged_out';
export interface WaStatus { state: WaState; since: number }

const KEY = 'wa_status';

/** Record a connection change; `since` only moves when the state changes. */
export function setWaStatus(store: Store, state: WaState, now: number) {
  const cur = getWaStatus(store);
  if (cur?.state === state) return;
  store.setKv(KEY, JSON.stringify({ state, since: now }));
}

export function getWaStatus(store: Store): WaStatus | null {
  const v = store.getKv(KEY);
  return v ? (JSON.parse(v) as WaStatus) : null;
}
