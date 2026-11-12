/** Telegram bot: POST https://api.telegram.org/bot<token>/sendMessage {chat_id, text}. `findChats` calls getUpdates
 *  (after the user has messaged the bot) so nobody has to look up a chat id by hand. */
import { ChannelError, str, apiBase, wrapNet, type ChannelAdapter, type HttpFn } from './types.ts';

export const telegram: ChannelAdapter = {
  kind: 'telegram',
  label: 'Telegram',
  secrets: ['botToken'],
  validate(c) {
    const botToken = str(c.botToken);
    if (!/^\d+:[\w-]{20,}$/.test(botToken)) throw new ChannelError('The bot token looks like 123456789:AAE… — copy it from @BotFather');
    const chatId = str(c.chatId);
    if (!/^-?\d+$|^@[\w]{4,}$/.test(chatId)) throw new ChannelError('Chat id should be a number (use "Find my chat" after messaging your bot)');
    return { botToken, chatId, apiBase: str(c.apiBase) };
  },
  describe: (c) => `chat ${c.chatId}`,
  async send(c, msg, deps) {
    const url = `${apiBase(c.apiBase, 'https://api.telegram.org')}/bot${c.botToken}/sendMessage`;
    try {
      const r = await deps.http(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: c.chatId, text: msg.text, disable_web_page_preview: true }) });
      let j: any = {};
      try { j = JSON.parse(r.text); } catch { /* not json */ }
      if (r.status < 200 || r.status >= 300 || j.ok === false) throw new ChannelError(`Telegram said ${r.status}: ${j.description ?? r.text.slice(0, 200)}`);
    } catch (e) { wrapNet(e, url); }
  },
};

export interface FoundChat { id: string; name: string; type: string }

/** Chats that have recently messaged the bot, newest first. */
export async function findChats(botToken: string, http: HttpFn, base?: string): Promise<FoundChat[]> {
  if (!/^\d+:[\w-]{20,}$/.test(str(botToken))) throw new ChannelError('Enter the bot token first');
  const url = `${apiBase(base, 'https://api.telegram.org')}/bot${str(botToken)}/getUpdates`;
  let r;
  try { r = await http(url, { method: 'GET' }); } catch (e) { wrapNet(e, url); }
  let j: any = {};
  try { j = JSON.parse(r!.text); } catch { /* not json */ }
  if (r!.status !== 200 || !j.ok) throw new ChannelError(`Telegram said ${r!.status}: ${j.description ?? 'unexpected answer'}`);
  const seen = new Map<string, FoundChat>();
  for (const u of [...(j.result ?? [])].reverse()) {
    const chat = (u.message ?? u.channel_post ?? u.edited_message ?? u.my_chat_member)?.chat;
    if (!chat || seen.has(String(chat.id))) continue;
    seen.set(String(chat.id), { id: String(chat.id), type: chat.type, name: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id) });
  }
  return [...seen.values()];
}
