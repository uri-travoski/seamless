import { email } from './email.ts';
import { twilio } from './twilio.ts';
import { smsGateway } from './smsGateway.ts';
import { telegram } from './telegram.ts';
import type { ChannelAdapter, ChannelKind } from './types.ts';

export const ADAPTERS: Record<ChannelKind, ChannelAdapter> = { email, twilio, sms_gateway: smsGateway, telegram };
export const CHANNEL_KINDS = Object.keys(ADAPTERS) as ChannelKind[];
export function adapter(kind: string): ChannelAdapter | null { return (ADAPTERS as Record<string, ChannelAdapter>)[kind] ?? null; }
export { GATEWAY_PRESETS } from './smsGateway.ts';
export { findChats } from './telegram.ts';
export * from './types.ts';
