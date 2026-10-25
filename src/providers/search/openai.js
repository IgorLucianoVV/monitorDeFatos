import OpenAI from 'openai';
import { config } from '../../config.js';

let client, clientKey;
const openai = () => {
  if (!client || clientKey !== config.keys.openai) {
    clientKey = config.keys.openai;
    client = new OpenAI({ apiKey: clientKey, maxRetries: 1, timeout: 60_000 });
  }
  return client;
};

const clean = (s) => s
  .replace(/\[[^\]]*\]\([^)]*\)/g, '')   // links markdown [host](url)
  .replace(/\(\s*\)/g, '')              // parênteses que sobram do link
  .replace(/\s+/g, ' ')
  .replace(/\s+([.,;:!?])/g, '$1')
  .replace(/[\s(]+$/, '')               // "(" aberto antes da citação
  .trim();

/**
 * Trecho que a citação sustenta.
 * A Responses API costuma pôr a citação DEPOIS do ponto final — "…segundo o Tesouro. ([host](url))" —
 * então o texto relevante é o que vem ANTES dela, não a "frase" onde o link está.
 * @param {number} prevEnd fim da citação anterior no mesmo bloco (para não misturar trechos de outra fonte)
 */
function citedSnippet(text, start, end, prevEnd = 0) {
  // 1) citação no meio da frase: usa a própria frase
  let s = start, e = end;
  while (s > 0 && !/[.!?\n]/.test(text[s - 1])) s--;
  while (e < text.length && !/[.!?\n]/.test(text[e])) e++;
  const inline = clean(text.slice(s, Math.min(text.length, e + 1)));
  if (inline.replace(/[^\p{L}\p{N}]/gu, '').length >= 25) return inline.slice(0, 600);

  // 2) citação após a frase: pega até 2 frases imediatamente anteriores
  const para = text.lastIndexOf('\n', start - 1) + 1;
  const before = clean(text.slice(Math.max(para, prevEnd), start));
  const sentences = before.split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.slice(-2).join(' ').slice(-600);
}

const stripTracking = (u) => {
  try { const x = new URL(u); x.searchParams.delete('utm_source'); return x.toString(); } catch { return u; }
};

/** Busca via Responses API (tool web_search) com filtro de domínios (só host, máx. 100) */
export async function search(query, { hosts }) {
  const reasoning = process.env.SEARCH_OPENAI_REASONING ?? 'low';
  const res = await openai().responses.create({
    model: config.search.openaiModel,
    ...(reasoning ? { reasoning: { effort: reasoning } } : {}),
    tools: [{ type: 'web_search', filters: { allowed_domains: hosts.slice(0, 100) } }],
    tool_choice: 'required', // sem isso o modelo pode responder de memória, sem fontes
    input: `Pesquise: ${query}\nResponda em 3 a 6 frases objetivas com os dados encontrados (números, período, órgão responsável). Cite a fonte de CADA frase. Não opine.`,
  });

  const out = [];
  for (const item of res.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) {
      const text = part.text || '';
      const anns = (part.annotations || [])
        .filter((a) => a.type === 'url_citation' && a.url)
        .sort((a, b) => (a.start_index ?? 0) - (b.start_index ?? 0));
      let prevEnd = 0;
      for (const a of anns) {
        out.push({
          url: stripTracking(a.url),
          title: a.title || a.url,
          snippet: citedSnippet(text, a.start_index ?? 0, a.end_index ?? 0, prevEnd),
          contexto: '',
        });
        prevEnd = a.end_index ?? prevEnd;
      }
    }
  }
  return out;
}

export const _internals = { citedSnippet, clean, sentenceAround: citedSnippet };
