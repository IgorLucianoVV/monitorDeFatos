import { StateSchema, StateGraph, START, END } from '@langchain/langgraph';
import * as z from 'zod';
import { config } from '../config.js';
import { structuredChain } from '../providers/llm.js';
import { normalizeText, todayPtBR } from '../lib/util.js';
import { ExtractionSchema } from './schemas.js';

const SYSTEM = () => `Você é o módulo de triagem de um verificador de fatos ao vivo para debates em português.
Recebe um trecho de transcrição automática (pode ter erros de reconhecimento) e extrai APENAS afirmações
factuais checáveis feitas no TRECHO NOVO.

Checável: dado numérico, estatística, fato histórico, atribuição de ato/fala a alguém, conteúdo de lei,
comparação mensurável, afirmação científica.
Ignore: opinião, juízo de valor, promessa, previsão, pergunta, ataque pessoal sem fato, retórica vaga, frase incompleta.

Regras:
- Reescreva cada afirmação de forma autocontida e fiel (resolva "isso", "ele", "lá" pelo contexto). Preserve o número exatamente como foi dito.
- Corrija só erros óbvios de transcrição (ex.: "ibegê" → "IBGE").
- Não repita afirmações de "JÁ CHECADAS", mesmo com outras palavras.
- No máximo 3 afirmações, priorizando as de maior impacto. Se nada for checável, retorne lista vazia.
Data de hoje: ${todayPtBR()}.`;

const ExtractState = new StateSchema({
  novo: z.string(),
  contexto: z.string().default(''),
  orador: z.string().default(''),
  jaChecadas: z.array(z.string()).default(() => []),
  candidatas: z.array(z.any()).default(() => []),
  afirmacoes: z.array(z.any()).default(() => []),
  provedor: z.string().default(''),
});

const overlap = (a, b) => {
  const A = new Set(normalizeText(a).split(' ').filter((w) => w.length > 2));
  const B = new Set(normalizeText(b).split(' ').filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
};

/**
 * Grafo: extrair (LLM) → deduplicar (determinístico) → END
 * @param {{ extractor?: { invoke(messages): Promise<{data, provider, model}> } }} deps
 */
export function buildExtractGraph(deps = {}) {
  const extractor = deps.extractor ?? structuredChain(config.llm.fast, ExtractionSchema, 'registrar_afirmacoes');

  const extrair = async (s) => {
    const user = [
      s.contexto && `CONTEXTO ANTERIOR (não extrair daqui):\n${s.contexto}`,
      s.orador && `ORADOR DO TRECHO NOVO: ${s.orador}`,
      s.jaChecadas.length && `JÁ CHECADAS:\n- ${s.jaChecadas.join('\n- ')}`,
      `TRECHO NOVO:\n${s.novo}`,
    ].filter(Boolean).join('\n\n');
    const r = await extractor.invoke([
      { role: 'system', content: SYSTEM() },
      { role: 'user', content: user },
    ]);
    return { candidatas: r.data?.afirmacoes ?? [], provedor: `${r.provider}:${r.model}` };
  };

  const deduplicar = (s) => {
    const out = [];
    for (const a of s.candidatas) {
      if (!a?.texto || a.texto.trim().length < 12) continue;
      const dup = [...s.jaChecadas, ...out.map((o) => o.texto)].some((t) => overlap(t, a.texto) >= 0.8);
      if (!dup) out.push({ texto: a.texto.trim(), trecho_original: a.trecho_original || '', categoria: a.categoria || 'outro' });
      if (out.length === 3) break;
    }
    return { afirmacoes: out };
  };

  return new StateGraph(ExtractState)
    .addNode('extrair', extrair)
    .addNode('deduplicar', deduplicar)
    .addEdge(START, 'extrair')
    .addEdge('extrair', 'deduplicar')
    .addEdge('deduplicar', END)
    .compile();
}
