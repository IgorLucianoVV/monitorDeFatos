import { config, hasKey, isTrustedUrl, trustedHosts } from '../../config.js';
import { errMsg, normUrl } from '../../lib/util.js';
import * as anthropic from './anthropic.js';
import * as openai from './openai.js';
import * as tavily from './tavily.js';

/** Registro de provedores de busca: nome → { key, search } */
const REGISTRY = {
  anthropic: { key: 'anthropic', search: anthropic.search },
  openai: { key: 'openai', search: openai.search },
  tavily: { key: 'tavily', search: tavily.search },
};

export const SEARCH_PROVIDERS = Object.keys(REGISTRY);

export function activeSearchProviders(names = config.search.providers) {
  return names.filter((n) => REGISTRY[n] && hasKey(REGISTRY[n].key));
}

/** Aplica a lista confiável (com path), descarta trechos vazios e funde duplicatas por URL */
export function sanitize(items, provider) {
  const byUrl = new Map();
  for (const it of items) {
    if (!it?.url || !isTrustedUrl(it.url)) continue;
    const snippet = (it.snippet || it.contexto || '').trim();
    if (snippet.length < 20) continue;
    const k = normUrl(it.url);
    const prev = byUrl.get(k);
    if (prev) {
      if (!prev.snippet.includes(snippet)) prev.snippet = `${prev.snippet} … ${snippet}`.slice(0, 1200);
    } else {
      byUrl.set(k, { url: it.url, title: it.title || it.url, snippet: snippet.slice(0, 800), provider: it.provider || provider });
    }
  }
  return [...byUrl.values()];
}

/**
 * Executa uma consulta.
 *  - mode "fallback": tenta os provedores na ordem até um devolver evidência válida
 *  - mode "merge": consulta todos em paralelo e junta (mais cobertura, mais custo)
 * @returns {{ evidence: object[], trace: string[] }}
 */
export async function runSearch(query, { providers = activeSearchProviders(), mode = config.search.mode, registry = REGISTRY } = {}) {
  const opts = { domains: config.trustedDomains, hosts: trustedHosts() };
  const trace = [];
  if (!providers.length) throw new Error('Nenhum provedor de busca configurado (ANTHROPIC/OPENAI/TAVILY)');

  const one = async (name) => {
    const t0 = Date.now();
    try {
      const ev = sanitize(await registry[name].search(query, opts), name);
      trace.push(`${name}: ${ev.length} evidência(s) em ${Date.now() - t0}ms`);
      return ev;
    } catch (e) {
      trace.push(`${name}: erro — ${errMsg(e)}`);
      return null;
    }
  };

  if (mode === 'merge') {
    const all = (await Promise.all(providers.map(one))).filter(Boolean).flat();
    return { evidence: sanitize(all, 'merge'), trace };
  }

  for (const name of providers) {
    const ev = await one(name);
    if (ev && ev.length) return { evidence: ev, trace };
  }
  return { evidence: [], trace };
}
