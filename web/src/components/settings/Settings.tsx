/** Settings shell (AD-6): left nav + content, one URL per page (/settings/<tab>). */
import type { ComponentType } from 'react';
import GeneralSettings from './GeneralSettings.tsx';
import AppearanceSettings from './AppearanceSettings.tsx';
import MailboxSettings from './MailboxSettings.tsx';
import LabelSettings from './LabelSettings.tsx';
import NotificationSettings from './NotificationSettings.tsx';
import SecuritySettings from './SecuritySettings.tsx';
import EncryptionSettings from './EncryptionSettings.tsx';
import FilterSettings from './FilterSettings.tsx';
import AiSettings from './AiSettings.tsx';
import UserSettings from './UserSettings.tsx';
import RulesSettings from './RulesSettings.tsx';
import AutomationSettings from './AutomationSettings.tsx';
import LogsSettings from './LogsSettings.tsx';
import HealthSettings from './HealthSettings.tsx';
import StorageSettings from './StorageSettings.tsx';
import DevicesSettings from './DevicesSettings.tsx';
import BackupSettings from './BackupSettings.tsx';
import SendingSettings from './SendingSettings.tsx';
import DisposableSettings from './DisposableSettings.tsx';
import BusinessSettings from './BusinessSettings.tsx';
import ContactsSettings from './ContactsSettings.tsx';
import IntegrationsSettings from './IntegrationsSettings.tsx';
import TemplatesView from '../TemplatesView.tsx';
import { useSession } from '../../state/session.ts';
import { useMail, scopeToSlug } from '../../state/mail.ts';
import { navigate } from '../../router.ts';
import {
  SettingsIcon, MailboxIcon, TagIcon, FilterIcon, SparkleIcon, UsersIcon, LogoutIcon, BackIcon, RulesIcon, ImportIcon,
  LogsIcon, DevicesIcon, ContactsIcon, SentIcon, BackupIcon, PaletteIcon, TemplateIcon, BellIcon, LockIcon, HelpIcon, KeyboardIcon, HealthIcon, TimerIcon, CloudIcon, KeyIcon,
} from '../../icons.tsx';
import LeadSettings from './LeadSettings.tsx';
import { useUi } from '../../state/ui.ts';

const TABS: { id: string; name: string; Icon: ComponentType<{ className?: string }>; C: ComponentType; admin?: boolean }[] = [
  { id: 'general', name: 'General', Icon: SettingsIcon, C: GeneralSettings },
  { id: 'appearance', name: 'Appearance', Icon: PaletteIcon, C: AppearanceSettings },
  { id: 'mailboxes', name: 'Mailboxes', Icon: MailboxIcon, C: MailboxSettings },
  { id: 'businesses', name: 'Businesses', Icon: ContactsIcon, C: BusinessSettings },
  { id: 'disposable', name: 'Disposable', Icon: TimerIcon, C: DisposableSettings },
  { id: 'sending', name: 'Sending', Icon: SentIcon, C: SendingSettings },
  { id: 'labels', name: 'Labels', Icon: TagIcon, C: LabelSettings },
  { id: 'templates', name: 'Templates', Icon: TemplateIcon, C: () => <><h2>Templates</h2><TemplatesView embedded /></> },
  { id: 'notifications', name: 'Notifications', Icon: BellIcon, C: NotificationSettings },
  { id: 'security', name: 'Security', Icon: LockIcon, C: SecuritySettings },
  { id: 'encryption', name: 'Encryption', Icon: KeyIcon, C: EncryptionSettings },
  { id: 'rules', name: 'Rules', Icon: RulesIcon, C: RulesSettings },
  { id: 'automation', name: 'Import & Retention', Icon: ImportIcon, C: AutomationSettings },
  { id: 'filters', name: 'Filters', Icon: FilterIcon, C: FilterSettings },
  { id: 'ai', name: 'AI', Icon: SparkleIcon, C: AiSettings },
  { id: 'integrations', name: 'Integrations', Icon: CloudIcon, C: IntegrationsSettings },
  { id: 'leads', name: 'Leads', Icon: ContactsIcon, C: LeadSettings },
  { id: 'contacts', name: 'Contacts', Icon: ContactsIcon, C: ContactsSettings },
  { id: 'devices', name: 'Devices', Icon: DevicesIcon, C: DevicesSettings },
  { id: 'health', name: 'Health', Icon: HealthIcon, C: HealthSettings },
  { id: 'logs', name: 'Logs', Icon: LogsIcon, C: LogsSettings },
  { id: 'storage', name: 'Storage', Icon: CloudIcon, C: StorageSettings, admin: true },
  { id: 'backup', name: 'Backup', Icon: BackupIcon, C: BackupSettings, admin: true },
  { id: 'users', name: 'Users', Icon: UsersIcon, C: UserSettings, admin: true },
];

export default function Settings({ tab }: { tab: string }) {
  const logout = useSession((s) => s.logout);
  const isAdmin = useSession((s) => s.user?.role === 'admin');
  const id = tab === 'accounts' ? 'mailboxes' : tab;
  const current = TABS.find((t) => t.id === id) ?? TABS[0];
  const tabs = TABS.filter((t) => !t.admin || isAdmin);
  const back = () => navigate({ page: 'mail', scope: scopeToSlug(useMail.getState().scope, useMail.getState().overview), folder: 'inbox' });

  return (
    <section className="page settings-page">
      <nav className="settings-nav" aria-label="Settings">
        <button className="side-item back-to-mail" onClick={back}><BackIcon className="glyph" /><span className="name">Back to mail</span></button>
        {tabs.map((t) => (
          <button key={t.id} className={`side-item ${current.id === t.id ? 'active' : ''}`} onClick={() => navigate({ page: 'settings', tab: t.id })}>
            <t.Icon className="glyph" />
            <span className="name">{t.name}</span>
          </button>
        ))}
        <div className="settings-nav-foot">
          <button className="side-item" onClick={() => void logout()}><LogoutIcon className="glyph" /><span className="name">Log out</span></button>
          <button className="icon-btn" title="Help — the user manual" aria-label="Help" onClick={() => useUi.getState().set({ helpOpen: true })}><HelpIcon size={18} /></button>
          <button className="icon-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => useUi.getState().set({ shortcutsOpen: true })}><KeyboardIcon size={18} /></button>
        </div>
      </nav>
      <div className="settings-content">
        <current.C />
      </div>
    </section>
  );
}
