import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';

let client, clientKey;
const anthropic = () => {
  if (!client || clientKey !== config.keys.anthropic) {
    clientKey = config.keys.anthropic;
    client = new Anthropic({ apiKey: clientKey, maxRetries: 1, timeout: 60_000 });
  }
  return client;
};

/**
 * Busca via ferramenta de servidor web_search da Anthropic.
 * O conteúdo bruto dos resultados vem criptografado; a evidência utilizável
 * são as CITAÇÕES (cited_text + url) da resposta.
 */
export async function search(query, { domains }) {
  const tool = {
    type: config.search.anthropicTool,
    name: 'web_search',
    max_uses: 2,
    allowed_domains: domains,
    user_location: { type: 'approximate', country: 'BR', timezone: 'America/Sao_Paulo' },
  };
  if (config.search.anthropicTool !== 'web_search_20250305') tool.allowed_callers = ['direct'];

  const messages = [{
    role: 'user',
    content: `Pesquise: ${query}\nResponda em 3 a 6 frases objetivas com os dados encontrados (números, período, órgão responsável), sempre citando as fontes. Não opine.`,
  }];

  const out = [];
  for (let i = 0; i < 3; i++) {
    const res = await anthropic().messages.create({
      model: config.search.anthropicModel, max_tokens: 1200, tools: [tool], messages,
    });
    for (const b of res.content) {
      if (b.type !== 'text' || !Array.isArray(b.citations)) continue;
      for (const c of b.citations) {
        if (!c.url) continue;
        out.push({ url: c.url, title: c.title || c.url, snippet: (c.cited_text || '').trim(), contexto: b.text.trim() });
      }
    }
    if (res.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: res.content });
  }
  return out;
}
