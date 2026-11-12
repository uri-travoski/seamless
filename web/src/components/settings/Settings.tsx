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
import AuditSettings from './AuditSettings.tsx';
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
  LogsIcon, DevicesIcon, ContactsIcon, SentIcon, BackupIcon, PaletteIcon, TemplateIcon, BellIcon, LockIcon, HelpIcon, KeyboardIcon, HealthIcon, TimerIcon, CloudIcon, KeyIcon, AuditIcon,
} from '../../icons.tsx';
import LeadSettings from './LeadSettings.tsx';
import SettingsSearch from './SettingsSearch.tsx';
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
  { id: 'audit', name: 'Audit log', Icon: AuditIcon, C: AuditSettings },
  { id: 'storage', name: 'Storage', Icon: CloudIcon, C: StorageSettings, admin: true },
  { id: 'backup', name: 'Backup', Icon: BackupIcon, C: BackupSettings, admin: true },
  { id: 'users', name: 'Users', Icon: UsersIcon, C: UserSettings, admin: true },
];

/** Manual page that explains each Settings tab (opened by the ? beside the tab title). */
export const TAB_HELP: Record<string, string> = {
  general: '01-getting-started', appearance: '01-getting-started', mailboxes: '05-accounts-providers',
  businesses: '18-businesses', disposable: '16-disposable', sending: '25-sending-receiving', labels: '02-reading-organizing',
  templates: '04-composing', notifications: '13-notifications', security: '12-security', encryption: '23-encryption',
  rules: '06-ai-automation', automation: '27-trash-retention', filters: '26-stopping-unwanted-senders', ai: '06-ai-automation',
  integrations: '20-integrations', leads: '21-leads', contacts: '08-devices-contacts', devices: '08-devices-contacts',
  health: '15-health', logs: '10-troubleshooting', audit: '22-audit-log', storage: '17-storage', backup: '11-backup-restore',
  users: '01-getting-started',
};

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
        <SettingsSearch tabs={tabs} isAdmin={isAdmin} />
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
        <button className="icon-btn settings-help-btn" title={`Help for ${current.name}`} aria-label={`Help for ${current.name}`}
          onClick={() => useUi.getState().set({ helpPage: TAB_HELP[current.id] ?? null, helpOpen: true })}><HelpIcon size={18} /></button>
        <current.C />
      </div>
    </section>
  );
}
