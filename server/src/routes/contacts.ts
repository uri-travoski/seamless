/** Contacts: addressbook, groups, auto-save settings, import/export (T8.11). Logic lives in contacts.ts and addressbook/. */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { bumpState } from '../db.ts';
import { harvestContacts, undoAutoSave, autoSaveEnabled, autoSaveRepliers, ownAddresses } from '../contacts.ts';
import { setUserSetting } from '../classify/settings.ts';
import { broadcast } from '../ws.ts';
import { uid } from './util.ts';
import {
  ContactError, toApi, queryContacts, createContact, updateContact, promoteContact, bulkAction, deleteAutoSaved, listGroups, createGroup, renameGroup,
  deleteGroup, findDuplicates, mergeContacts, recentConversations, lookupByEmail, addSenderToContacts, suggest, checkAddress, importFile, exportContacts,
  type ContactFilter, type ImportMode,
} from '../addressbook/manage.ts';
import type { ExportFormat } from '../addressbook/formats.ts';

const EXPORTS: ExportFormat[] = ['vcf', 'google', 'outlook', 'csv', 'json'];

export function register(app: FastifyInstance): void {
  const changed = async (userId: number) => { await bumpState(); broadcast({ type: 'stateChange' }, userId); };
  const guard = async <T>(reply: FastifyReply, fn: () => Promise<T>) => {
    try { return await fn(); } catch (e) {
      if (e instanceof ContactError) return reply.code(e.statusCode).send({ error: e.message, ...e.extra });
      throw e;
    }
  };
  const idOf = (req: any) => Number(req.params.id);

  // ---- auto-save switch ----
  app.get('/api/contacts/settings', async (req) => ({ autoSave: await autoSaveEnabled(uid(req)), saveRepliers: await autoSaveRepliers(uid(req)) }));
  app.put('/api/contacts/settings', async (req) => {
    const b = (req.body ?? {}) as { autoSave?: boolean; saveRepliers?: boolean };
    if (typeof b.autoSave === 'boolean') await setUserSetting(uid(req), 'contacts_auto_save', b.autoSave ? 'true' : 'false');
    if (typeof b.saveRepliers === 'boolean') await setUserSetting(uid(req), 'contacts_save_repliers', b.saveRepliers ? 'true' : 'false');
    return { ok: true, autoSave: await autoSaveEnabled(uid(req)), saveRepliers: await autoSaveRepliers(uid(req)) };
  });

  // ---- list / create / edit ----
  app.get('/api/contacts', async (req) => {
    const qs = req.query as any;
    const rows = await queryContacts(uid(req), {
      filter: ['all', 'mine', 'auto', 'hidden', 'business'].includes(qs.filter) ? qs.filter as ContactFilter : '',
      sort: qs.sort, q: qs.q, groupId: qs.group ? Number(qs.group) : undefined, hiddenToo: qs.hidden === '1',
    });
    return rows.map(toApi);
  });

  app.post('/api/contacts', async (req, reply) => guard(reply, async () => {
    const id = await createContact(uid(req), (req.body ?? {}) as any);
    await changed(uid(req));
    return { id };
  }));

  app.put('/api/contacts/:id', async (req, reply) => guard(reply, async () => {
    await updateContact(uid(req), idOf(req), (req.body ?? {}) as any);
    await changed(uid(req));
    return { ok: true };
  }));

  app.delete('/api/contacts/:id', async (req) => {
    await bulkAction(uid(req), [idOf(req)], 'delete');
    await changed(uid(req));
    return { ok: true };
  });

  app.post('/api/contacts/:id/promote', async (req, reply) => {
    if (!(await promoteContact(uid(req), idOf(req)))) return reply.code(404).send({ error: 'Contact not found' });
    await changed(uid(req));
    return { ok: true };
  });

  /** Undo of the "Saved to contacts" toast: removes only a contact that is still auto-created. */
  app.post('/api/contacts/:id/undo-save', async (req) => {
    const removed = await undoAutoSave(uid(req), idOf(req));
    if (removed) await changed(uid(req));
    return { removed };
  });

  app.get('/api/contacts/:id/detail', async (req, reply) => guard(reply, () => recentConversations(uid(req), idOf(req))));

  app.post('/api/contacts/bulk', async (req, reply) => guard(reply, async () => {
    const b = (req.body ?? {}) as { ids?: number[]; action?: string; groupId?: number };
    const n = await bulkAction(uid(req), (b.ids ?? []).map(Number), String(b.action ?? ''), b.groupId);
    await changed(uid(req));
    return { changed: n };
  }));

  app.delete('/api/contacts', async (req, reply) => {
    if ((req.query as any).autoSaved !== '1' || (req.query as any).confirm !== '1') return reply.code(400).send({ error: 'Pass autoSaved=1&confirm=1' });
    const n = await deleteAutoSaved(uid(req));
    await changed(uid(req));
    return { deleted: n };
  });

  // ---- duplicates ----
  app.get('/api/contacts/duplicates', async (req) => {
    const pairs = await findDuplicates(uid(req));
    const byId = new Map((await queryContacts(uid(req), { filter: 'all' })).map((c) => [c.id, toApi(c)]));
    return pairs.map((p) => ({ reason: p.reason, a: byId.get(p.a), b: byId.get(p.b) })).filter((p) => p.a && p.b);
  });
  app.post('/api/contacts/merge', async (req, reply) => guard(reply, async () => {
    const b = (req.body ?? {}) as { keepId?: number; mergeId?: number };
    await mergeContacts(uid(req), Number(b.keepId), Number(b.mergeId));
    await changed(uid(req));
    return { ok: true };
  }));

  // ---- groups ----
  app.get('/api/contact-groups', async (req) => listGroups(uid(req)));
  app.post('/api/contact-groups', async (req, reply) => guard(reply, async () => {
    const id = await createGroup(uid(req), String((req.body as any)?.name ?? ''));
    await changed(uid(req));
    return { id };
  }));
  app.put('/api/contact-groups/:id', async (req, reply) => guard(reply, async () => {
    await renameGroup(uid(req), idOf(req), String((req.body as any)?.name ?? ''));
    await changed(uid(req));
    return { ok: true };
  }));
  app.delete('/api/contact-groups/:id', async (req) => {
    await deleteGroup(uid(req), idOf(req));
    await changed(uid(req));
    return { ok: true };
  });

  // ---- compose helpers ----
  app.get('/api/contacts/suggest', async (req) => suggest(uid(req), String((req.query as any).q ?? '')));
  app.get('/api/contacts/check', async (req) => checkAddress(uid(req), String((req.query as any).email ?? ''), String((req.query as any).name ?? '')));
  app.get('/api/contacts/lookup', async (req) => {
    const email = String((req.query as any).email ?? '');
    return { contact: await lookupByEmail(uid(req), email), own: (await ownAddresses(uid(req))).has(email.trim().toLowerCase()) };
  });
  app.post('/api/contacts/add-sender', async (req, reply) => guard(reply, async () => {
    const b = (req.body ?? {}) as { email?: string; name?: string };
    const id = await addSenderToContacts(uid(req), String(b.email ?? ''), String(b.name ?? ''));
    await changed(uid(req));
    return { id };
  }));

  // ---- export ----
  const doExport = async (req: any, reply: FastifyReply, format: ExportFormat) => {
    const qs = req.query as any;
    const out = await exportContacts(uid(req), {
      format, ids: qs.ids ? String(qs.ids).split(',').map(Number).filter(Number.isFinite) : undefined,
      groupId: qs.group ? Number(qs.group) : undefined, filter: qs.filter,
    });
    const name = format === 'vcf' ? 'seamless-contacts' : `seamless-contacts-${format}`;
    reply.header('Content-Type', out.mime);
    reply.header('Content-Disposition', `attachment; filename="${name}.${out.ext}"`);
    return reply.send(out.body);
  };
  app.get('/api/contacts/export.vcf', (req, reply) => doExport(req, reply, 'vcf'));
  app.get('/api/contacts/export', (req, reply) => {
    const f = String((req.query as any).format ?? 'vcf') as ExportFormat;
    if (!EXPORTS.includes(f)) return reply.code(400).send({ error: 'format must be one of ' + EXPORTS.join(', ') });
    return doExport(req, reply, f);
  });

  // ---- import: ?preview=1 only reports; ?mode=skip|merge|fill; ?mapping={"email":["Col"],…} for CSV ----
  app.post('/api/contacts/import', async (req, reply) => {
    const part = await (req as any).file();
    if (!part) return reply.code(400).send({ error: 'no file' });
    const qs = req.query as any;
    const mode: ImportMode = ['skip', 'merge', 'fill'].includes(qs.mode) ? qs.mode : 'merge';
    let mapping;
    if (qs.mapping) { try { mapping = JSON.parse(qs.mapping); } catch { return reply.code(400).send({ error: 'mapping is not valid JSON' }); } }
    const report = await importFile(uid(req), await part.toBuffer(), { mode, dryRun: qs.preview === '1', mapping });
    if (!report.preview) await changed(uid(req));
    return { ...report, created: report.created };
  });

  // manual "Rebuild from mail": this user only, whole history
  app.post('/api/contacts/harvest', async (req) => {
    const scanned = await harvestContacts({ userId: uid(req), full: true });
    await changed(uid(req));
    return { scanned };
  });
}
