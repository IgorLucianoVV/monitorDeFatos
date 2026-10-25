import { config } from '../../config.js';

/** Tavily Search API — retorna trechos de conteúdo das páginas; aceita include_domains */
export async function search(query, { hosts }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.keys.tavily}` },
      body: JSON.stringify({
        query,
        search_depth: 'advanced',
        max_results: 5,
        include_domains: hosts,
        include_answer: false,
      }),
    });
    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data.results || []).map((r) => ({
      url: r.url, title: r.title || r.url, snippet: String(r.content || '').slice(0, 700).trim(), contexto: '',
    }));
  } finally { clearTimeout(t); }
}
