import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { BackIcon } from '../icons.tsx';
import { useUi } from '../state/ui.ts';

/** Tiny markdown subset renderer: headings, bold, code, links, lists, paragraphs. */
function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inList: '' | 'ul' | 'ol' = ''; let para: string[] = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (inList) { out.push(`</${inList}>`); inList = ''; } };
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    const li = ul ?? ol;
    if (li) {
      const kind = ul ? 'ul' : 'ol';
      flushPara();
      if (inList !== kind) { flushList(); out.push(`<${kind}>`); inList = kind; }
      out.push(`<li>${inline(li[1])}</li>`); continue;
    }
    if (line.trim() === '') { flushPara(); flushList(); continue; }
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join('\n');
}

export default function HelpModal({ onClose }: { onClose: () => void }) {
  const [pages, setPages] = useState<{ id: string; title: string }[]>([]);
  const [page, setPage] = useState<string>('');
  const [html, setHtml] = useState('');

  useEffect(() => {
    void api.get<{ id: string; title: string }[]>('/api/help').then((p) => {
      setPages(p);
      const want = useUi.getState().helpPage;
      useUi.getState().set({ helpPage: null });
      setPage(p.find((x) => x.id === want)?.id ?? p[0]?.id ?? '');
    });
  }, []);

  useEffect(() => {
    if (!page) return;
    void fetch(`/api/help/${page}`, { credentials: 'same-origin' })
      .then((r) => r.text())
      .then((md) => setHtml(mdToHtml(md)));
  }, [page]);

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="settings-nav">
          {pages.map((p) => (
            <button key={p.id} className={`side-item ${page === p.id ? 'active' : ''}`} onClick={() => setPage(p.id)}>
              <span className="name">{p.title}</span>
            </button>
          ))}
          <div style={{ marginTop: 18, borderTop: '1px solid var(--md-border)', paddingTop: 10 }}>
            <button className="side-item" onClick={onClose}>
              <BackIcon className="glyph" /><span className="name">Back to mail</span>
            </button>
          </div>
        </div>
        <div className="settings-content help-content" dangerouslySetInnerHTML={{ __html: html }}
          onClick={(e) => {
            // links between manual pages (e.g. 05-accounts-providers.md) stay inside Help
            const a = (e.target as HTMLElement).closest('a');
            const m = a?.getAttribute('href')?.match(/^(?:\.\/)?([a-z0-9-]+)\.md(?:#.*)?$/i);
            if (m && pages.some((p) => p.id === m[1])) { e.preventDefault(); setPage(m[1]); }
          }} />
      </div>
    </div>
  );
}
