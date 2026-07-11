import { useState } from 'react';
import GeneralSettings from './GeneralSettings.tsx';
import AccountSettings from './AccountSettings.tsx';
import LabelSettings from './LabelSettings.tsx';
import FilterSettings from './FilterSettings.tsx';
import AiSettings from './AiSettings.tsx';
import UserSettings from './UserSettings.tsx';
import RulesSettings from './RulesSettings.tsx';
import AutomationSettings from './AutomationSettings.tsx';
import LogsSettings from './LogsSettings.tsx';
import DevicesSettings from './DevicesSettings.tsx';
import ContactsSettings from './ContactsSettings.tsx';
import { useSession } from '../../state/session.ts';
import type { ComponentType } from 'react';
import { SettingsIcon, AccountIcon, TagIcon, FilterIcon, SparkleIcon, UsersIcon, LogoutIcon, BackIcon, RulesIcon, ImportIcon, LogsIcon, DevicesIcon, ContactsIcon } from '../../icons.tsx';

const TABS: { id: string; name: string; Icon: ComponentType<{ className?: string }> }[] = [
  { id: 'general', name: 'General', Icon: SettingsIcon },
  { id: 'accounts', name: 'Accounts', Icon: AccountIcon },
  { id: 'labels', name: 'Labels', Icon: TagIcon },
  { id: 'rules', name: 'Rules', Icon: RulesIcon },
  { id: 'automation', name: 'Import & Retention', Icon: ImportIcon },
  { id: 'filters', name: 'Filters', Icon: FilterIcon },
  { id: 'ai', name: 'AI', Icon: SparkleIcon },
  { id: 'contacts', name: 'Contacts', Icon: ContactsIcon },
  { id: 'devices', name: 'Devices', Icon: DevicesIcon },
  { id: 'logs', name: 'Logs', Icon: LogsIcon },
  { id: 'users', name: 'Users', Icon: UsersIcon },
];

export default function Settings({ onClose, initialTab }: { onClose: () => void; initialTab?: string }) {
  const [tab, setTab] = useState<string>(initialTab && TABS.some((t) => t.id === initialTab) ? initialTab : 'general');
  const logout = useSession((s) => s.logout);

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="settings-nav">
          {TABS.map((t) => (
            <button key={t.id} className={`side-item ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              <t.Icon className="glyph" />
              <span className="name">{t.name}</span>
            </button>
          ))}
          <div style={{ marginTop: 18, borderTop: '1px solid var(--md-border)', paddingTop: 10 }}>
            <button className="side-item" onClick={() => void logout()}>
              <LogoutIcon className="glyph" /><span className="name">Log out</span>
            </button>
            <button className="side-item" onClick={onClose}>
              <BackIcon className="glyph" /><span className="name">Back to mail</span>
            </button>
          </div>
        </div>
        <div className="settings-content">
          {tab === 'general' && <GeneralSettings />}
          {tab === 'accounts' && <AccountSettings />}
          {tab === 'labels' && <LabelSettings />}
          {tab === 'filters' && <FilterSettings />}
          {tab === 'ai' && <AiSettings />}
          {tab === 'rules' && <RulesSettings />}
          {tab === 'automation' && <AutomationSettings />}
          {tab === 'contacts' && <ContactsSettings />}
          {tab === 'devices' && <DevicesSettings />}
          {tab === 'logs' && <LogsSettings />}
          {tab === 'users' && <UserSettings />}
        </div>
      </div>
    </div>
  );
}
