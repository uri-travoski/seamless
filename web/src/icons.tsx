import type React from 'react';
// Central Phosphor icon barrel. All icons render filled by default (set via
// IconContext in main.tsx). Import from here so glyph choices stay consistent.

// App logo: the envelope from /icon.svg (same artwork as the favicon and the Android app icon).
export function MailLogo({ size = '1.3em' }: { size?: string | number }) {
  const h = typeof size === 'number' ? `${size * 0.85}px` : `calc(${size} * 0.85)`;
  return <img src="/icon.svg" alt="" aria-hidden="true" style={{ height: h, width: 'auto', display: 'block', flex: 'none' }} />;
}

// Archive glyphs supplied by the user: outline box for the toolbar, solid-lid box for the sidebar.
type IconProps = { size?: number | string; className?: string };
export function ArchiveToolbarIcon({ size = 18, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M224,36H32A16,16,0,0,0,16,52V76A16,16,0,0,0,32,92V204a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V92a16,16,0,0,0,16-16V52A16,16,0,0,0,224,36ZM208,204H48V92H208ZM224,76H32V52H224V76ZM96,132a8,8,0,0,1,8-8h48a8,8,0,0,1,0,16H104A8,8,0,0,1,96,132Z" />
    </svg>
  );
}
export function ArchiveSidebarIcon({ size = 18, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M224,36H32A16,16,0,0,0,16,52V76A16,16,0,0,0,32,92V204a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V92a16,16,0,0,0,16-16V52A16,16,0,0,0,224,36Zm-72,104H104a8,8,0,0,1,0-16h48a8,8,0,0,1,0,16Zm72-64H32V52H224V76Z" />
    </svg>
  );
}

// Custom outline paperclip used for the attachment flag in list rows.
export function AttachClipIcon({ size = '1.2em', className, ...rest }: { size?: number | string; className?: string; [k: string]: unknown }) {
  return (
    <svg stroke="currentColor" fill="none" strokeWidth="0" viewBox="0 0 24 24" height={size} width={size} className={className} xmlns="http://www.w3.org/2000/svg" {...rest}>
      <path fill="none" strokeWidth="2" d="M22,12 C22,12 19.0000009,15.0000004 13.0000004,21.0000004 C6.99999996,27.0000004 -2.00000007,18.0000004 3.99999994,12.0000004 C9.99999996,6.00000037 9,7.00000011 13,3.00000008 C17,-0.999999955 23,4.99999994 19,9.00000005 C15,13.0000002 12.0000004,16.0000007 9.99999995,18.0000004 C7.99999952,20 5,17 6.99999995,15.0000004 C8.99999991,13.0000007 16,6 16,6" />
    </svg>
  );
}

// Cloud-download mark for the "check all accounts for new mail" button.
export function CloudDownloadIcon({ size = '1em' }: { size?: string | number }) {
  return (
    <svg stroke="currentColor" fill="currentColor" strokeWidth="0" viewBox="0 0 512 512" height={size} width={size} xmlns="http://www.w3.org/2000/svg">
      <path fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="32" d="M320 336h76c55 0 100-21.21 100-75.6s-53-73.47-96-75.6C391.11 99.74 329 48 256 48c-69 0-113.44 45.79-128 91.2-60 5.7-112 35.88-112 98.4S70 336 136 336h56m0 64.1 64 63.9 64-63.9M256 224v224.03" />
    </svg>
  );
}

export {
  MagnifyingGlass as SearchIcon,
  Gear as SettingsIcon,
  List as MenuIcon,
  X as CloseIcon,
  Tray as InboxIcon,
  NotePencil as ComposeIcon,
  FileText as DraftsIcon,
  PaperPlaneRight as SentIcon,
  Clock as ScheduledIcon,
  Archive as ArchiveIcon,
  WarningOctagon as JunkIcon,
  Trash as TrashIcon,
  Folder as FolderIcon,
  CaretDown as CaretDownIcon,
  CaretRight as CaretRightIcon,
  Star as StarIcon,
  Eye as EyeIcon,
  EyeSlash as EyeSlashIcon,
  DotsThree as MoreToolsIcon,
  Paperclip as AttachIcon,
  Envelope as EnvelopeIcon,
  EnvelopeOpen as EnvelopeOpenIcon,
  Tag as TagIcon,
  ArrowsClockwise as RefreshIcon,
  Check as CheckIcon,
  ArrowLeft as BackIcon,
  Sparkle as SparkleIcon,
  ArrowBendUpLeft as ReplyIcon,
  ArrowBendDoubleUpLeft as ReplyAllIcon,
  ArrowBendUpRight as ForwardIcon,
  DownloadSimple as DownloadIcon,
  PencilSimple as PencilIcon,
  Image as ImageIcon,
  Minus as MinimizeIcon,
  Square as MaximizeIcon,
  CornersIn as RestoreIcon,
  ArrowCounterClockwise as UndoIcon,
  ArrowClockwise as RedoIcon,
  TextB as BoldIcon,
  TextItalic as ItalicIcon,
  TextUnderline as UnderlineIcon,
  TextStrikethrough as StrikethroughIcon,
  Highlighter as HighlightIcon,
  ListBullets as BulletListIcon,
  ListNumbers as NumberedListIcon,
  Quotes as QuoteIcon,
  Code as CodeIcon,
  TextAlignLeft as AlignLeftIcon,
  TextAlignCenter as AlignCenterIcon,
  TextAlignRight as AlignRightIcon,
  LinkSimple as LinkIcon,
  Eraser as ClearFormatIcon,
  UserCircle as AccountIcon,
  Funnel as FilterIcon,
  SlidersHorizontal as SearchOptionsIcon,
  SignOut as LogoutIcon,
  TextAa as FontSizeIcon,
  BellSimple as BellIcon,
  ShieldCheck as ShieldIcon,
  Palette as PaletteIcon,
  PlusCircle as PlusIcon,
  WarningCircle as WarningIcon,
  Rows as TableViewIcon,
  ArrowsInLineVertical as CompactIcon,
  ArrowsOutLineVertical as ComfortableIcon,
  DotsThreeVertical as KebabIcon,
  Code as SourceIcon,
  Note as NoteIcon,
  ArrowUUpLeft as RestoreMailIcon,
  UsersThree as UsersIcon,
  TreeStructure as RulesIcon,
  UploadSimple as ImportIcon,
  ListMagnifyingGlass as LogsIcon,
  ShieldCheck as AuditIcon,
  Question as ReviewIcon,
  DeviceMobileCamera as DevicesIcon,
  AddressBook as ContactsIcon,
  Lightbulb as SuggestionIcon,
  Question as HelpIcon,
  HardDrives as BackupIcon,
  Printer as PrinterIcon,
  UserMinus as BlockIcon,
  Briefcase as BriefcaseIcon,
  House as HouseIcon,
  Timer as TimerIcon,
  Stack as UnifiedIcon,
  Keyboard as KeyboardIcon,
  Sun as SunIcon,
  Moon as MoonIcon,
  Desktop as SystemIcon,
  Lock as LockIcon,
  LockKey as LockKeyIcon,
  SealCheck as SealCheckIcon,
  Copy as CopyIcon,
  Checks as ChecksIcon,
  FileText as TemplateIcon,
  ArrowsDownUp as SortIcon,
  DotsSixVertical as DragIcon,
  Plus as PlusSimpleIcon,
  MagnifyingGlass as FilterSearchIcon,
  ChartBar as ChartIcon,
  SpeakerHigh as SoundIcon,
  CaretLeft as CaretLeftIcon,
  CaretUp as CaretUpIcon,
  Circle as CircleIcon,
  ArrowSquareOut as ExternalIcon,
  Bell as BellFillIcon,
  Users as PeopleIcon,
  ShieldWarning as ShieldWarnIcon,
  BellSimpleZ as SnoozeIcon,
  BookOpenText as ReadLaterIcon,
  Hourglass as WaitingIcon,
  Alarm as AlarmIcon,
  Heartbeat as HealthIcon,
  CloudArrowUp as CloudIcon,
  Key as KeyIcon,
  Envelope as MailboxIcon,
  SidebarSimple as SidebarCollapseIcon,
} from '@phosphor-icons/react';

/** Category icon by name (mailbox_categories.icon). */
export { CategoryGlyph } from './components/CategoryGlyph.tsx';

/** Square with a centre divider (the split-view icon from the design mock-up). */
export function SplitViewIcon({ size = 18, ...rest }: { size?: number | string } & React.SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="12" y1="3" x2="12" y2="21" />
    </svg>
  );
}
