import { create } from 'zustand';
import { renderTemplate, templateQuestions, type ApiTemplate, type ApiIdentity, type ApiAddress } from '@seamless/shared';
import { api } from '../api/client.ts';

interface TemplateState {
  list: ApiTemplate[];
  loaded: boolean;
  refresh: () => Promise<void>;
  save: (t: Partial<ApiTemplate> & { name: string; bodyHtml: string }) => Promise<number>;
  remove: (id: number) => Promise<void>;
}

export const useTemplates = create<TemplateState>((set, get) => ({
  list: [],
  loaded: false,
  refresh: async () => {
    try { set({ list: await api.get<ApiTemplate[]>('/api/templates'), loaded: true }); } catch { /* offline */ }
  },
  save: async (t) => {
    let id = t.id ?? 0;
    if (t.id) await api.put(`/api/templates/${t.id}`, t);
    else id = (await api.post<{ id: number }>('/api/templates', t)).id;
    await get().refresh();
    return id;
  },
  remove: async (id) => {
    await api.del(`/api/templates/${id}`);
    await get().refresh();
  },
}));

// ---- {{?Question}} prompts: a promise-based dialog mounted once (ComposeDock) ----

interface AskState {
  questions: string[] | null;
  title: string;
  resolve: ((answers: Record<string, string> | null) => void) | null;
}

export const useAsk = create<AskState>(() => ({ questions: null, title: '', resolve: null }));

export function askQuestions(title: string, questions: string[]): Promise<Record<string, string> | null> {
  if (questions.length === 0) return Promise.resolve({});
  return new Promise((resolve) => useAsk.setState({ questions, title, resolve }));
}

/** Fill a template for the compose window. Recipient tokens wait until send if To is empty. */
export async function fillTemplate(t: ApiTemplate, ctx: { identity: ApiIdentity | null; to: ApiAddress[]; subject: string }): Promise<{ subject: string; html: string } | null> {
  const answers = await askQuestions(t.name, templateQuestions(t.subject, t.bodyHtml));
  if (!answers) return null;
  const c = {
    recipient: ctx.to[0] ?? null,
    sender: ctx.identity ? { name: ctx.identity.name, email: ctx.identity.email } : null,
    subject: ctx.subject || t.subject,
    answers,
  };
  void api.post(`/api/templates/${t.id}/use`).catch(() => {});
  return {
    subject: renderTemplate(t.subject, c, { keepRecipientTokens: true }),
    html: renderTemplate(t.bodyHtml, c, { html: true, keepRecipientTokens: true }),
  };
}
