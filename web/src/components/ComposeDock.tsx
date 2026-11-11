import { lazy, Suspense, useEffect, useState } from 'react';
import { useCompose } from '../state/compose.ts';
import { useAsk } from '../state/templates.ts';

// TipTap is heavy; load it only when a compose window opens
const ComposeWindow = lazy(() => import('./ComposeWindow.tsx'));

/** Answers for a template's {{?Question}} placeholders. */
function AskDialog() {
  const { questions, title, resolve } = useAsk();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  useEffect(() => { setAnswers({}); }, [questions]);
  if (!questions || !resolve) return null;
  const done = (ok: boolean) => { resolve(ok ? answers : null); useAsk.setState({ questions: null, resolve: null }); };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) done(false); }}>
      <div className="modal small" role="dialog" aria-label="Fill in the template">
        <div className="modal-title">{title}</div>
        <form className="modal-body" onSubmit={(e) => { e.preventDefault(); done(true); }}>
          {questions.map((q, i) => (
            <div className="field" key={q}>
              <label>{q}</label>
              <input className="text-input" autoFocus={i === 0} value={answers[q] ?? ''} onChange={(e) => setAnswers({ ...answers, [q]: e.target.value })} />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" type="submit">Insert</button>
            <button className="btn ghost" type="button" onClick={() => done(false)}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function ComposeDock() {
  const windows = useCompose((s) => s.windows);
  return (
    <>
      <AskDialog />
      {windows.length > 0 && (
        <div className="compose-dock">
          <Suspense fallback={null}>
            {windows.map((w) => <ComposeWindow key={w.key} draft={w} />)}
          </Suspense>
        </div>
      )}
    </>
  );
}
