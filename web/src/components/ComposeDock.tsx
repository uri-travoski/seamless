import { lazy, Suspense } from 'react';
import { useCompose } from '../state/compose.ts';

// TipTap is heavy; load it only when a compose window opens
const ComposeWindow = lazy(() => import('./ComposeWindow.tsx'));

export default function ComposeDock() {
  const windows = useCompose((s) => s.windows);
  if (windows.length === 0) return null;
  return (
    <div className="compose-dock">
      <Suspense fallback={null}>
        {windows.map((w) => <ComposeWindow key={w.key} draft={w} />)}
      </Suspense>
    </div>
  );
}
