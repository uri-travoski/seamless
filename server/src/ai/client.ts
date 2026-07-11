import type { AiTask } from '@seamless/shared';
import { one } from '../db.ts';
import { decrypt } from '../crypto.ts';

export interface ProviderConfig {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export async function getProvider(userId: number, id: number): Promise<ProviderConfig | null> {
  const r = await one<any>('SELECT * FROM ai_providers WHERE id = ? AND user_id = ?', [id, userId]);
  if (!r) return null;
  return {
    id: r.id, name: r.name, baseUrl: r.base_url.replace(/\/$/, ''),
    apiKey: r.api_key_enc ? decrypt(r.api_key_enc) : '', model: r.model,
  };
}

/** Resolve provider+model for a task from the ai_tasks mapping. */
export async function getTaskProvider(userId: number, task: AiTask): Promise<ProviderConfig | null> {
  const t = await one<any>('SELECT * FROM ai_tasks WHERE user_id = ? AND task = ? AND enabled = true', [userId, task]);
  if (!t?.provider_id) return null;
  const p = await getProvider(userId, t.provider_id);
  if (!p) return null;
  return { ...p, model: t.model || p.model };
}

export async function chatComplete(
  provider: ProviderConfig,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  opts: { json?: boolean; maxTokens?: number } = {},
): Promise<string> {
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      temperature: 0.2,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI provider error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as any;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('AI provider returned no content');
  return content;
}

/** Tolerant JSON extraction: handles code fences and prose-wrapped JSON. */
export function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  const braces = candidate.match(/\{[\s\S]*\}/);
  if (braces) { try { return JSON.parse(braces[0]); } catch { /* fall through */ } }
  return null;
}
