import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { CheckIcon, CloseIcon } from '../icons.tsx';
import { useCompose } from '../state/compose.ts';

interface WizardStatus { accounts: number; rules: number; aiReady: boolean; devices: number }

const DISMISS_KEY = 'seamless-wizard-dismissed';

/** First-run checklist shown over the empty reading pane until the basics are wired up. */
export default function GettingStarted({ openSettings, openHelp }: {
  openSettings: (tab: string) => void;
  openHelp: () => void;
}) {
  const [status, setStatus] = useState<WizardStatus | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');

  const refresh = () => void api.get<WizardStatus>('/api/wizard/status').then(setStatus).catch(() => {});
  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, []);

  // the card and the compose dock share the bottom-right corner: step aside while composing
  const composing = useCompose((st) => st.windows.length > 0);
  if (dismissed || !status || composing) return null;
  const steps = [
    { done: status.accounts > 0, label: 'Connect a mailbox', hint: 'Gmail/Microsoft via OAuth, or any IMAP server', tab: 'mailboxes' },
    { done: status.rules > 0, label: 'Import your rules spreadsheet', hint: 'labels + retention + rules in one go (or add rules by hand)', tab: 'automation' },
    { done: status.aiReady, label: 'Enable the AI classifier', hint: 'map the Classify + Embeddings tasks to a provider', tab: 'ai' },
    { done: status.devices > 0, label: 'Connect your phone or mail app', hint: 'app password + the server settings card', tab: 'devices' },
  ];
  if (steps.every((s) => s.done)) return null;

  return (
    <div className="wizard-card">
      <button className="icon-btn wizard-close" title="Dismiss" onClick={() => { localStorage.setItem(DISMISS_KEY, '1'); setDismissed(true); }}>
        <CloseIcon size={16} />
      </button>
      <h3>Set up Seamless</h3>
      <p className="settings-desc" style={{ marginTop: 2 }}>
        Four steps to a self-cleaning mailbox. The <button className="linklike" onClick={openHelp}>manual</button> walks through each one.
      </p>
      {steps.map((s) => (
        <button key={s.tab} className={`wizard-step ${s.done ? 'done' : ''}`} onClick={() => openSettings(s.tab)}>
          <span className="wizard-tick">{s.done ? <CheckIcon size={14} weight="bold" /> : null}</span>
          <span className="wizard-label">
            <b>{s.label}</b>
            <span>{s.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
