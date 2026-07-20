import { useState } from 'react';
import { useTwoWallsStore } from './store';
import { TopBar, type TabId } from './components/TopBar';
import { Toasts } from './components/Alerts';
import { LiveFeed } from './components/LiveFeed';
import { ReconPanel } from './components/ReconPanel';
import { GovernancePanel } from './components/GovernancePanel';
import { AuditPanel } from './components/AuditPanel';
import { DemoControls } from './components/DemoControls';
import { Brand, Spinner } from './components/ui';

export default function App() {
  const { state, dispatch } = useTwoWallsStore();
  const [tab, setTab] = useState<TabId>('feed');
  const snap = state.snapshot;

  if (!snap) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <Brand size="lg" />
        <div className="flex items-center gap-2 text-sm text-ink-muted">
          <Spinner className="h-4 w-4 text-local" />
          {state.conn === 'offline'
            ? 'Coordinator unreachable. Retrying…'
            : 'Connecting to the coordinator…'}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <TopBar tab={tab} onTab={setTab} conn={state.conn} alerts={snap.alerts} />
      <Toasts toasts={state.toasts} dispatch={dispatch} />
      <div className="flex min-h-0 flex-1">
        {/* main panel area */}
        <main className="min-w-0 flex-1 overflow-y-auto p-4 xl:p-6">
          {tab === 'feed' && <LiveFeed snap={snap} />}
          {tab === 'recon' && <ReconPanel snap={snap} />}
          {tab === 'governance' && <GovernancePanel snap={snap} />}
          {tab === 'audit' && <AuditPanel snap={snap} />}
        </main>
        {/* always-visible demo control rail */}
        <div className="w-[300px] shrink-0 border-l border-edge bg-panel/60">
          <DemoControls snap={snap} />
        </div>
      </div>
    </div>
  );
}
