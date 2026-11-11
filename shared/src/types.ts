// Shared API contract between server and web client.

export type MailboxRole = 'inbox' | 'sent' | 'drafts' | 'scheduled' | 'trash' | 'junk' | 'archive' | null;

export interface ApiUser {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'member';
}

export interface ApiMailbox {
  id: string;              // "mb:<rowid>" or unified "u:<role>"
  accountId: number | null; // null for unified virtual mailboxes
  name: string;
  path: string;
  role: MailboxRole;
  totalEmails: number;
  unreadEmails: number;
}

export interface ApiAddress {
  name: string;
  email: string;
}

export interface ApiLabel {
  id: number;
  name: string;
  color: string;
  description: string;
  keepDefault?: boolean;
  retentionDays?: number | null;
  protected?: boolean;
  autoMarkRead?: boolean;
  sort?: number;
  parentId?: number | null;                          // nesting (T1 F-11)
  sidebarVisibility?: 'always' | 'unread' | 'hidden';
  total?: number;                                    // messages carrying it (outside Bin/Spam)
  unread?: number;
}

export interface ApiRule {
  id: number;
  enabled: boolean;
  ord: number;
  matchField: string;
  matchValue: string;
  excludeContains: string;
  action: 'label' | 'ai';
  labelId: number | null;
  stop: boolean;
  note: string;
  source: string;
  hitCount: number;
}

export interface ApiPreference {
  id: number;
  enabled: boolean;
  guidance: string;
  version: number;
}

export interface ApiProcessingLog {
  id: number;
  emailId: number | null;
  kind: string;
  level: string;
  message: string;
  createdAt: string;
}

export type BackupFrequency = 'every_n_hours' | 'twice_daily' | 'daily' | 'every_2_days' | 'twice_weekly' | 'weekly' | 'monthly';

export interface ApiBackupConfig {
  enabled: boolean;
  frequency: BackupFrequency;
  hour: number;              // UTC hour of the run slot
  keep: number;              // runs retained in the bucket
  prefix: string;
  alertEmail: string;
  everyHours: number;        // 1–24, when frequency = every_n_hours
  includeEmails: boolean;    // mirror mail blobs into the backup store
}

export interface ApiBackupStatus {
  lastAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string;
  lastKey: string;
  lastRows: number;
  lastBytes: number;
  acknowledged: boolean;
  nextDueAt: number | null;
  running: boolean;
}

export interface ApiBackup {
  key: string;
  createdAt: number;
  rows: number;
  bytes: number;
  tables: number;
}

export interface ApiEmail {
  id: string;              // "m<rowid>"
  threadId: string;
  accountId: number;
  accountEmail: string;
  accountColor: string;
  mailboxId: string;
  mailboxRole: MailboxRole;
  keywords: Record<string, boolean>; // $seen, $flagged, $answered, $draft
  labelIds: number[];
  from: ApiAddress[];
  to: ApiAddress[];
  cc: ApiAddress[];
  replyTo: ApiAddress[];
  subject: string;
  preview: string;
  receivedAt: string;      // ISO
  messageId: string | null;
  size: number;
  hasAttachment: boolean;
  hasNote: boolean;        // a personal note is attached (private, never sent)
  openCount: number;       // real tracking-pixel opens (own sent mail), -1 = not tracked
  autoOpenCount?: number;  // probable automatic opens (mail privacy proxies, scanners) — not in openCount
  lastOpenAt: string | null;
  threadOpenCount: number; // opens on your tracked reply elsewhere in this thread, -1 = none
  threadOpenAt: string | null;
  disposition: 'keep' | 'delete';
  deleteAt: string | null; // when the retention sweep will trash it (countdown badge)
  needsReview: boolean;
  snoozedUntil: string | null; // ISO while snoozed (hidden from the Inbox until then)
  risk: { level: 'medium' | 'high'; reasons: { code: string; severity: 'medium' | 'high'; text: string }[] } | null; // T2 F-20
  followupId: number | null;   // T2 F-19: a live reminder on this sent message
  followupDueAt: string | null;
  followupStatus: 'waiting' | 'due' | null;
  bounced: { recipient: string; status: string; diagnostic: string }[] | null; // T3 F-22: delivery failed for these
  disposable: { id: number; address: string; label: string; status: 'active' | 'paused' | 'disposed' } | null; // T3 F-25
}

export interface ApiAttachmentMeta {
  partId: string;
  filename: string;
  contentType: string;
  size: number;
  cid: string | null;
  inline: boolean;
}

export interface TrackingOpen {
  ts: string;    // ISO
  ip: string;
  ua: string;
}

export interface TrackingInfo {
  token: string;
  opens: number;
  lastOpenAt: string | null;
  log: TrackingOpen[];
}

export interface ApiEmailBody {
  id: string;
  html: string | null;       // sanitized, cid: rewritten, remote images stripped to data-md-src
  text: string | null;
  hasBlockedRemote: boolean;
  note: string;              // personal note body ('' = none)
  attachments: ApiAttachmentMeta[];
  headers: { deliveredTo: string | null; messageId: string | null; listUnsubscribe: string | null; seamlessTrack?: boolean | null };
  tracking: TrackingInfo | null;
}

export interface EmailQueryFilter {
  snoozed?: boolean;         // T2: only mail currently snoozed, soonest first
  waiting?: boolean;         // T2: sent mail with a live follow-up reminder
  scope?: ScopeId;           // T1: unified | category:<id> | account:<id> (default unified)
  inMailbox?: string;        // "mb:<id>" or "u:<role>"
  label?: number;
  text?: string;             // search query language
  accountId?: number;
  hasKeyword?: string;
  notKeyword?: string;
  needsReview?: boolean;     // the review lane: low-confidence / ai-routed mail
}

export interface EmailQueryRequest {
  filter: EmailQueryFilter;
  position: number;
  limit: number;
}

export interface EmailQueryResponse {
  ids: string[];
  total: number;
  position: number;
  queryState: string;
}

export interface ApiIdentity {
  accountId: number;
  email: string;
  name: string;
  isAlias: boolean;
  /** T4 F-30: identity record (absent for disposable addresses) */
  id?: number;
  businessId?: number | null;
  isDefault?: boolean;
  signatureHtml?: string | null;
  replyTo?: string | null;
  bccSelf?: boolean;
  transportId?: number | null;
}

export interface ApiBusiness {
  id: number; name: string; shortName: string; hasLogo: boolean; brandColor: string; website: string; phone: string;
  abn: string; address: string; defaultSignatureHtml: string; disclaimerHtml: string;
}

export interface ComposePayload {
  accountId: number;
  fromEmail: string;
  identityId?: number;       // T4 F-30: sending identity (name, reply-to, bcc-self, transport); absent = legacy fromEmail
  to: ApiAddress[];
  cc: ApiAddress[];
  bcc: ApiAddress[];
  subject: string;
  html: string;
  inReplyTo?: string;        // message-id header
  replyToEmailId?: string;   // our row id, to set $answered
  attachmentIds: string[];   // uploaded temp attachment ids
  track: boolean;
  perRecipientTracking?: boolean; // separate copy + token per recipient (T1 F-15, default off)
  draftId?: string;          // existing draft row id to replace
  attachments?: { id: string; filename: string; size: number }[]; // so Undo can rebuild the chips
  followupDays?: number;     // T2 F-19: remind me if no reply in N days
}

export interface FilterCondition {
  field: 'from' | 'to' | 'cc' | 'subject' | 'body' | 'has_attachment' | 'account';
  op: 'contains' | 'not_contains' | 'equals' | 'starts_with' | 'ends_with';
  value: string;
}

export interface FilterAction {
  type: 'move' | 'label' | 'markRead' | 'star' | 'delete';
  value?: string;            // mailbox role for move, label id for label
}

export interface ApiFilter {
  id: number;
  name: string;
  enabled: boolean;
  sort: number;
  match: 'all' | 'any';
  conditions: FilterCondition[];
  actions: FilterAction[];
  stop: boolean;
}

export interface ApiAiProvider {
  id: number;
  name: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export type AiTask = 'classify' | 'embed' | 'categorize' | 'summarize' | 'draft';

/** Orthogonal-fields verdict from the LLM classify tier — never a single label. */
export interface AiVerdict {
  category: string;
  label: string | null;
  is_real_document: boolean;
  requires_action: boolean;
  worth_keeping: boolean;
  retention: 'keep' | 'delete' | 'keep_1y' | 'keep_2y' | 'keep_3y';
  warranty_months: number | null;
  confidence: number;
  reason: string;
}

export interface ApiRuleSuggestion {
  id: number;
  matchField: string;
  matchValue: string;
  labelId: number;
  evidence: number;
}

export interface ApiProcessorNote {
  id: number;
  scope: 'sender' | 'domain';
  scopeValue: string;
  note: string;
  labelId: number | null;
  autoRead: boolean;
  retentionDays: number | null;
  deleteIfUnread: boolean;
  active: boolean;
}

export interface ApiDecision {
  tier: string;
  model: string;
  output: AiVerdict | Record<string, unknown>;
  confidence: number;
  reason: string;
  createdAt: string;
}

// ---- mailbox categories + scope (T1 F-07/F-08) ----

/** 'unified' | 'category:<id>' | 'account:<id>' */
export type ScopeId = string;

export interface ApiCategory {
  id: number;
  key: string;               // 'work' | 'personal' | 'disposable' | slug for custom
  name: string;
  icon: string;
  color: string;
  sortOrder: number;
  builtin: boolean;
  accountIds: number[];
  unread: number;            // inbox unread across member mailboxes
}

export interface ApiCategoryMailbox {
  id: number;
  name: string;
  email: string;
  color: string;
  enabled: boolean;
  unread: number;
  categoryIds: number[];
}

export interface ApiCategoryOverview {
  unifiedUnread: number;
  categories: ApiCategory[];
  mailboxes: ApiCategoryMailbox[];
}

export interface TestStep {
  step: 'dns' | 'tcp' | 'tls' | 'auth' | 'folders' | 'send';
  ok: boolean;
  ms: number;
  detail: string;
}

// ---- templates (T1 F-12) ----

export interface ApiTemplate {
  id: number;
  name: string;
  category: string;
  subject: string;
  bodyHtml: string;
  accountId: number | null;
  shortcut: string | null;
  useCount: number;
  updatedAt: number;
}

// ---- open report (T1 F-15) ----

export interface ApiOpen {
  ts: number;
  recipient: string | null;
  client: string;
  ip: string;
  country: string | null;
  proxied: boolean;
}

export interface ApiOpenReport {
  emailId: string;
  subject: string;
  sentAt: number | null;
  to: ApiAddress[];
  perRecipient: boolean;
  summary: { total: number; real: number; firstAt: number | null; lastAt: number | null; uniqueDevices: number };
  opens: ApiOpen[];
}

// ---- events + notifications (T0 F-04, T1 F-13/F-14) ----

export type EventType =
  | 'mail.received' | 'mail.opened' | 'mail.bounced'
  | 'send.failed' | 'send.sent'
  | 'reminder.due' | 'snooze.woke' | 'followup.due'
  | 'sync.failed' | 'oauth.expiring' | 'job.failed' | 'storage.unreachable'
  | 'backup.failed' | 'backup.ok'
  | 'storage.migration.done' | 'storage.migration.failed'
  | 'export.created' | 'export.imported'
  | 'disposable.received' | 'disposable.leak' | 'lead.captured' | 'assignment.changed'
  | 'security.login' | 'security.2fa_changed';

/** UI filter groups on the notifications page (each maps to one or more event types). */
export const NOTIFICATION_GROUPS: { id: string; name: string; types: EventType[] }[] = [
  { id: 'mail', name: 'New mail', types: ['mail.received', 'disposable.received', 'disposable.leak'] },
  { id: 'opened', name: 'Opened', types: ['mail.opened'] },
  { id: 'reminders', name: 'Reminders', types: ['reminder.due'] },
  { id: 'followups', name: 'Follow-ups', types: ['followup.due'] },
  { id: 'snooze', name: 'Snooze', types: ['snooze.woke'] },
  { id: 'send', name: 'Send failures', types: ['send.failed', 'mail.bounced'] },
  { id: 'sync', name: 'Sync errors', types: ['sync.failed', 'oauth.expiring', 'job.failed'] },
  { id: 'backup', name: 'Backups', types: ['backup.failed', 'backup.ok', 'storage.unreachable', 'storage.migration.done', 'storage.migration.failed', 'export.created', 'export.imported'] },
  { id: 'security', name: 'Security', types: ['security.login', 'security.2fa_changed'] },
  { id: 'leads', name: 'Leads', types: ['lead.captured'] },
  { id: 'assignments', name: 'Assignments', types: ['assignment.changed'] },
];

export interface ApiNotification {
  id: number;
  type: EventType;
  title: string;
  body: string;
  link: string | null;       // in-app route, e.g. /mail/msg/m123/opens
  accountId: number | null;
  accountColor: string | null;
  count: number;             // grouped repeats ("Opened 5x")
  read: boolean;
  createdAt: number;         // epoch ms
  updatedAt: number;
}

export interface ApiNotificationPage {
  items: ApiNotification[];
  total: number;
  unread: number;
}

export interface ApiNotificationPref {
  type: EventType;
  inApp: boolean;
  push: boolean;
  emailDigest: boolean;
}

export interface WsMessage {
  type: 'stateChange' | 'newMail' | 'counts' | 'notifications';
  state?: string;
  accountId?: number;
  mailboxRole?: MailboxRole;
  from?: string;
  subject?: string;
}

export * from './templates.ts';

// ---- outbound transports (T3 F-22) ----

export type TransportKind = 'smtp' | 'sendgrid' | 'brevo' | 'ses' | 'mailgun' | 'postmark' | 'cloudflare';

export interface ApiTransport {
  id: number;
  kind: TransportKind;
  name: string;
  /** Non-secret settings (host, port, region…). Secrets are never returned. */
  config: Record<string, unknown>;
  hasApiKey: boolean;
  fallbackId: number | null;
  dailyLimit: number | null;
  createdAt: number;
}

export interface TransportTestResult {
  ok: boolean;
  steps: { name: string; ok: boolean; detail?: string }[];
}

// ---- disposable addresses (T3 F-25) ----
export interface ApiDisposable {
  id: number; accountId: number; address: string; label: string; purpose: string;
  status: 'active' | 'paused' | 'disposed'; expiresAt: number | null; notify: boolean;
  receivedCount: number; droppedCount: number; lastReceivedAt: number | null; lastSender: string;
  signupDomain: string | null; leakDomains: string[]; disposedAt: number | null; createdAt: number;
  canUndo: boolean;
}
