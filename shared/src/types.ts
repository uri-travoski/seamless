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
  /** T4 F-32: set when the mailbox belongs to someone else and is shared with you. */
  shared?: boolean;
  sharedRole?: 'viewer' | 'responder' | 'manager';
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
  shared?: boolean;                                  // T8.2: someone else's label shared with me (read-only)
  sharedBy?: string;
  sharedAccountIds?: number[];
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
  vip?: boolean; // T4 F-35: sender is one of the viewer's VIPs
  assignment?: ApiAssignment | null; // T4 F-32: only set when the thread is assigned / has a status
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
  newsletter?: { sender: string; choice: 'inbox' | 'read_later' | 'unsubscribed' | null; unsubscribe: 'one-click' | 'mailto' | 'link' | null } | null; // T6.3: set when the message looks like a newsletter
  readLater?: boolean;          // T6.3: in the Read later folder
  readMinutes?: number | null;  // T6.3: estimated reading time (words / 230 wpm), newsletters only
  snoozedUntil: string | null; // ISO while snoozed (hidden from the Inbox until then)
  snoozedBy?: string | null;   // T8.3: name of the teammate who snoozed a shared thread
  snoozeAllowed?: boolean;     // T8.3: false on a shared mailbox whose team settings keep snoozing off (or for viewers)
  risk: { level: 'medium' | 'high'; reasons: { code: string; severity: 'medium' | 'high'; text: string }[] } | null; // T2 F-20
  followupId: number | null;   // T2 F-19: a live reminder on this sent message
  followupDueAt: string | null;
  followupStatus: 'waiting' | 'due' | null;
  /** T6.2: set client-side from the query response ('Matched in invoice.pdf: …'). */
  attachmentMatch?: { filename: string; snippet: string } | null;
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
  invite?: ApiInvite | null; // T4 F-33: calendar invite carried by this message
  pgp?: ApiPgpStatus | null; // T6.4 F-39: OpenPGP badge when the message is signed / encrypted
  smime?: ApiSmimeStatus | null; // T6.5 F-39: S/MIME badge
  pgpKeys?: ApiPgpKeyOffer[]; // public keys attached to the message that can be imported
}

export interface ApiPgpStatus {
  encrypted: boolean; decrypted: boolean; signature: 'verified' | 'unverified' | 'bad' | 'none';
  signer?: string; fingerprint?: string; locked?: boolean; error?: string;
}
export interface ApiSmimeStatus {
  encrypted: boolean; decrypted: boolean; signature: 'verified' | 'unverified' | 'bad' | 'none';
  signer?: string; issuer?: string; fingerprint?: string; error?: string;
}
export interface ApiSmimeCert {
  id: number; kind: 'own' | 'contact'; identityId: number | null; email: string; fingerprint: string; subject: string; issuer: string;
  hasPrivate: boolean; notAfter: number; expired: boolean; createdAt: number;
}
export interface ApiPgpKeyOffer { partId: string; filename: string; fingerprint: string; email: string; name: string; known: boolean }
export interface ApiPgpKey {
  id: number; kind: 'own' | 'contact'; identityId: number | null; email: string; name: string; fingerprint: string;
  hasPrivate: boolean; passphraseProtected: boolean; createdAt: number; expires: number | null;
}

export interface ApiInviteAttendee { name: string; email: string; partstat: string; role: string }
export interface ApiInvite {
  id: number;
  uid: string;
  sequence: number;
  method: string;
  summary: string;
  startsAt: number | null;     // epoch ms (UTC)
  endsAt: number | null;
  allDay: boolean;
  tz: string | null;           // organiser's zone (IANA) when it is not UTC
  location: string;
  url: string;
  videoUrl: string | null;     // Meet / Zoom / Teams link found in url, location or description
  organizer: { name: string; email: string } | null;
  attendees: ApiInviteAttendee[];
  status: 'active' | 'cancelled';
  myPartstat: string | null;
  myEmail: string | null;
  canRsvp: boolean;
  caldavConnected: boolean;
}

export interface EmailQueryFilter {
  readLater?: boolean;       // T6.3: only mail in the Read later folder, newest first
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
  messageId?: number;        // T4 F-34: restrict to one message row (notify-on-match test)
}

export interface EmailQueryRequest {
  filter: EmailQueryFilter;
  position: number;
  limit: number;
}

export interface EmailQueryResponse {
  ids: string[];
  /** T6.2: for a text search, where an attachment (not the body) matched: email id → file + highlighted snippet. */
  attachmentMatches?: Record<string, { filename: string; snippet: string }>;
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
  pgpSign?: boolean;         // T6.4 F-39: sign with the sender's OpenPGP key (PGP/MIME)
  pgpEncrypt?: boolean;      // encrypt to every recipient (and to yourself)
  smimeSign?: boolean;       // T6.5 F-39: S/MIME signature (cannot be combined with the OpenPGP toggles)
  smimeEncrypt?: boolean;    // S/MIME encryption to every recipient (and to yourself)
  pgpPassphrase?: string;    // only when the key is passphrase-protected; never stored
  quickReplyId?: number;     // T4 F-31: sent straight from a quick-reply chip (server re-checks it is safe to send directly)
}

export interface FilterCondition {
  field: 'from' | 'to' | 'cc' | 'subject' | 'body' | 'has_attachment' | 'account';
  op: 'contains' | 'not_contains' | 'equals' | 'starts_with' | 'ends_with';
  value: string;
}

export interface FilterAction {
  type: 'move' | 'label' | 'markRead' | 'star' | 'delete' | 'send_to_webhook' | 'send_to_dms' | 'send_to_bizbooks' | 'create_task';
  value?: string;            // mailbox role for move, label id for label, webhook id for send_to_webhook (T5.2: the DMS/BizBooks/task actions use the first connector of that kind unless a webhook id is given)
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
  /** T4 F-32: mailboxes other users shared with you (scope `shared:<id>`). */
  shared: { id: number; name: string; email: string; color: string; role: 'viewer' | 'responder' | 'manager'; owner: string; unread: number }[];
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
  /** T4 F-31 */
  businessId?: number | null;
  pinned?: boolean;
  pinOrder?: number;
  sendDirect?: boolean;
  lastUsedAt?: number | null;
  kind?: 'reply' | 'marketing';
  hasAi?: boolean;
}

export interface ApiTemplateRender {
  subject: string;
  html: string;
  /** every {{ai:}} placeholder was filled (or there were none) */
  aiFilled: boolean;
  /** placeholders left for the user (no AI provider / call failed) */
  aiPending: number;
  note?: string;
  /** confirm-free send is allowed for this render */
  canSendDirect: boolean;
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
  | 'disposable.received' | 'disposable.leak' | 'lead.captured' | 'view.match' | 'assignment.changed' | 'comment.mention'
  | 'security.login' | 'security.2fa_changed'
  | 'webhook.failed'
  | 'quota.warning' | 'quota.full'
  | 'labels.offered'
  | 'archive.done' | 'archive.failed';

/** UI filter groups on the notifications page (each maps to one or more event types). */
export const NOTIFICATION_GROUPS: { id: string; name: string; types: EventType[] }[] = [
  { id: 'mail', name: 'New mail', types: ['mail.received', 'disposable.received', 'disposable.leak'] },
  { id: 'opened', name: 'Opened', types: ['mail.opened'] },
  { id: 'reminders', name: 'Reminders', types: ['reminder.due'] },
  { id: 'followups', name: 'Follow-ups', types: ['followup.due'] },
  { id: 'snooze', name: 'Snooze', types: ['snooze.woke'] },
  { id: 'send', name: 'Send failures', types: ['send.failed', 'mail.bounced'] },
  { id: 'sync', name: 'Sync errors', types: ['sync.failed', 'oauth.expiring', 'job.failed'] },
  { id: 'backup', name: 'Backups', types: ['backup.failed', 'backup.ok', 'storage.unreachable', 'storage.migration.done', 'storage.migration.failed', 'export.created', 'export.imported', 'archive.done', 'archive.failed'] },
  { id: 'security', name: 'Security', types: ['security.login', 'security.2fa_changed'] },
  { id: 'leads', name: 'Leads', types: ['lead.captured'] },
  { id: 'integrations', name: 'Integrations', types: ['webhook.failed'] },
  { id: 'views', name: 'Smart views', types: ['view.match'] },
  { id: 'quota', name: 'Mailbox space', types: ['quota.warning', 'quota.full'] },
  { id: 'assignments', name: 'Assignments', types: ['assignment.changed', 'comment.mention', 'labels.offered'] },
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
  type: 'stateChange' | 'newMail' | 'counts' | 'notifications' | 'presence' | 'contactsSaved';
  state?: string;
  // contactsSaved (T8.11): contacts just auto-created by a send, for the "Saved to contacts · Undo" toast
  contacts?: { id: number; name: string; email: string }[];
  // presence (T4 F-32)
  threadId?: string;
  action?: 'replying' | 'viewing' | 'left';
  userId?: number;
  userName?: string;
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

// ---- shared inbox workflow (T4 F-32) ----
export interface ApiAssignment {
  accountId: number; threadId: string;
  assigneeId: number | null; assigneeName: string | null;
  status: 'open' | 'pending' | 'done';
  dueAt: number | null; updatedAt: number;
}
export interface ApiThreadComment { id: number; userId: number; userName: string; body: string; mentions: number[]; createdAt: number }

// ---- saved searches / smart views (T4 F-34) ----
export interface ApiSavedView {
  id: number; name: string; icon: string; color: string | null; query: string; scope: string; sort: string;
  pinned: boolean; showCount: boolean; sortOrder: number; notify: boolean;
}
export interface ApiViewSuggestion { key: string; name: string; icon: string; query: string }
export * from './addresses.ts';
