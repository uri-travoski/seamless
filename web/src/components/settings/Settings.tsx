/** Settings shell (AD-6): left nav + content, one URL per page (/settings/<tab>). */
import { Fragment, type ComponentType } from 'react';
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
import ArchivesSettings from './ArchivesSettings.tsx';
import SendingSettings from './SendingSettings.tsx';
import DisposableSettings from './DisposableSettings.tsx';
import BusinessSettings from './BusinessSettings.tsx';
import ContactsSettings from './ContactsSettings.tsx';
import IntegrationsSettings from './IntegrationsSettings.tsx';
import AlertsSettings from './AlertsSettings.tsx';
import TemplatesView from '../TemplatesView.tsx';
import { useSession } from '../../state/session.ts';
import { useMail, scopeToSlug } from '../../state/mail.ts';
import { navigate } from '../../router.ts';
import {
  SettingsIcon, MailboxIcon, TagIcon, FilterIcon, SparkleIcon, UsersIcon, LogoutIcon, BackIcon, RulesIcon, ImportIcon,
  LogsIcon, DevicesIcon, ContactsIcon, SentIcon, BackupIcon, PaletteIcon, TemplateIcon, BellIcon, LockIcon, HelpIcon, KeyboardIcon, HealthIcon, TimerIcon, CloudIcon, KeyIcon, AuditIcon, ReadLaterIcon,
} from '../../icons.tsx';
import LeadSettings from './LeadSettings.tsx';
import NewsletterSettings from './NewsletterSettings.tsx';
import SettingsSearch from './SettingsSearch.tsx';
import { useUi } from '../../state/ui.ts';

type Tab = { id: string; name: string; group: string; Icon: ComponentType<{ className?: string }>; C: ComponentType; admin?: boolean };
/** Order here = order in the menu; `group` makes the section headings. */
const TABS: Tab[] = [
  { id: 'general', name: 'General', group: 'Mail', Icon: SettingsIcon, C: GeneralSettings },
  { id: 'mailboxes', name: 'Mailboxes', group: 'Mail', Icon: MailboxIcon, C: MailboxSettings },
  { id: 'sending', name: 'Sending', group: 'Mail', Icon: SentIcon, C: SendingSettings },
  { id: 'disposable', name: 'Disposable', group: 'Mail', Icon: TimerIcon, C: DisposableSettings },
  { id: 'businesses', name: 'Businesses', group: 'Business', Icon: ContactsIcon, C: BusinessSettings },
  { id: 'leads', name: 'Leads', group: 'Business', Icon: ContactsIcon, C: LeadSettings },
  { id: 'integrations', name: 'Integrations', group: 'Business', Icon: CloudIcon, C: IntegrationsSettings },
  { id: 'labels', name: 'Labels', group: 'Organise', Icon: TagIcon, C: LabelSettings },
  { id: 'filters', name: 'Filters', group: 'Organise', Icon: FilterIcon, C: FilterSettings },
  { id: 'rules', name: 'Rules', group: 'Organise', Icon: RulesIcon, C: RulesSettings },
  { id: 'templates', name: 'Templates', group: 'Organise', Icon: TemplateIcon, C: () => <><h2>Templates</h2><TemplatesView embedded /></> },
  { id: 'newsletters', name: 'Newsletters', group: 'Organise', Icon: ReadLaterIcon, C: () => <><h2>Newsletters</h2><NewsletterSettings /></> },
  { id: 'ai', name: 'AI', group: 'Organise', Icon: SparkleIcon, C: AiSettings },
  { id: 'notifications', name: 'Notifications', group: 'Alerts & look', Icon: BellIcon, C: NotificationSettings },
  { id: 'appearance', name: 'Appearance', group: 'Alerts & look', Icon: PaletteIcon, C: AppearanceSettings },
  { id: 'security', name: 'Security', group: 'Security', Icon: LockIcon, C: SecuritySettings },
  { id: 'alerts', name: 'Alerts', group: 'Security', Icon: BellIcon, C: AlertsSettings },
  { id: 'encryption', name: 'Encryption', group: 'Security', Icon: KeyIcon, C: EncryptionSettings },
  { id: 'audit', name: 'Audit log', group: 'Security', Icon: AuditIcon, C: AuditSettings },
  { id: 'storage', name: 'Storage', group: 'Data', Icon: CloudIcon, C: StorageSettings },
  { id: 'backup', name: 'Backup', group: 'Data', Icon: BackupIcon, C: BackupSettings, admin: true },
  { id: 'archives', name: 'Archives', group: 'Data', Icon: BackupIcon, C: ArchivesSettings, admin: true },
  { id: 'automation', name: 'Import', group: 'Data', Icon: ImportIcon, C: AutomationSettings },
  { id: 'contacts', name: 'Contacts', group: 'Devices', Icon: ContactsIcon, C: ContactsSettings },
  { id: 'devices', name: 'Devices', group: 'Devices', Icon: DevicesIcon, C: DevicesSettings },
  { id: 'health', name: 'Health', group: 'System', Icon: HealthIcon, C: HealthSettings },
  { id: 'logs', name: 'Logs', group: 'System', Icon: LogsIcon, C: LogsSettings },
  { id: 'users', name: 'Users', group: 'System', Icon: UsersIcon, C: UserSettings, admin: true },
];
export const SETTINGS_TABS = TABS.map((t) => ({ id: t.id, name: t.name, group: t.group, admin: t.admin }));

/** Manual page that explains each Settings tab (opened by the ? beside the tab title). */
export const TAB_HELP: Record<string, string> = {
  general: '01-getting-started', appearance: '01-getting-started', mailboxes: '05-accounts-providers',
  businesses: '18-businesses', disposable: '16-disposable', sending: '25-sending-receiving', labels: '02-reading-organizing',
  templates: '04-composing', notifications: '13-notifications', security: '12-security', encryption: '23-encryption',
  rules: '06-ai-automation', automation: '06-ai-automation', filters: '26-stopping-unwanted-senders', ai: '06-ai-automation',
  integrations: '20-integrations', leads: '21-leads', contacts: '08-devices-contacts', devices: '08-devices-contacts',
  health: '15-health', alerts: '31-alerts', logs: '10-troubleshooting', audit: '22-audit-log', storage: '17-storage', backup: '11-backup-restore', archives: '30-viewing-old-mail',
  users: '29-administrator', newsletters: '02-reading-organizing',
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
        {tabs.map((t, i) => (
          <Fragment key={t.id}>
            {(i === 0 || tabs[i - 1]!.group !== t.group) && <div className="settings-nav-group">{t.group}</div>}
            <button className={`side-item ${current.id === t.id ? 'active' : ''}`} onClick={() => navigate({ page: 'settings', tab: t.id })}>
              <t.Icon className="glyph" />
              <span className="name">{t.name}</span>
            </button>
          </Fragment>
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
