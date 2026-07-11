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
  openCount: number;       // tracking pixel opens (own sent mail), -1 = not tracked
  lastOpenAt: string | null;
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
  headers: { deliveredTo: string | null; messageId: string | null; listUnsubscribe: string | null };
  tracking: TrackingInfo | null;
}

export interface EmailQueryFilter {
  inMailbox?: string;        // "mb:<id>" or "u:<role>"
  label?: number;
  text?: string;             // search query language
  accountId?: number;
  hasKeyword?: string;
  notKeyword?: string;
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
}

export interface ComposePayload {
  accountId: number;
  fromEmail: string;
  to: ApiAddress[];
  cc: ApiAddress[];
  bcc: ApiAddress[];
  subject: string;
  html: string;
  inReplyTo?: string;        // message-id header
  replyToEmailId?: string;   // our row id, to set $answered
  attachmentIds: string[];   // uploaded temp attachment ids
  track: boolean;
  draftId?: string;          // existing draft row id to replace
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

export type AiTask = 'categorize' | 'summarize' | 'draft';

export interface WsMessage {
  type: 'stateChange' | 'newMail' | 'counts';
  state?: string;
  accountId?: number;
  mailboxRole?: MailboxRole;
  from?: string;
  subject?: string;
}
