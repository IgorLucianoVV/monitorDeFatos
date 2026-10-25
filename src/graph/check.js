import { StateSchema, ReducedValue, StateGraph, START, END, Send } from '@langchain/langgraph';
import * as z from 'zod';
import { config } from '../config.js';
import { structuredChain } from '../providers/llm.js';
import { runSearch } from '../providers/search/index.js';
import { TtlCache, normUrl, normalizeText, todayPtBR } from '../lib/util.js';
import { PlanSchema, VerdictSchema, VEREDITOS } from './schemas.js';

export const verdictCache = new TtlCache(config.cacheTtlMs);

const concat = (a, b) => a.concat(b ?? []);

/** Evidências: funde por URL e numera (E1, E2…) na ordem de chegada */
function mergeEvidence(left, right) {
  const out = left.map((e) => ({ ...e }));
  for (const e of right ?? []) {
    const k = normUrl(e.url);
    const prev = out.find((x) => normUrl(x.url) === k);
    if (prev) {
      if (!prev.snippet.includes(e.snippet)) prev.snippet = `${prev.snippet} … ${e.snippet}`.slice(0, 1200);
    } else if (out.length < config.search.maxEvidence) {
      out.push({ ...e, id: `E${out.length + 1}` });
    }
  }
  return out;
}

const CheckState = new StateSchema({
  afirmacao: z.string(),
  orador: z.string().default(''),
  contexto: z.string().default(''),
  rodada: z.number().default(0),
  consultas: z.array(z.string()).default(() => []),
  consulta: z.string().default(''), // payload do Send
  consultasFeitas: new ReducedValue(z.array(z.string()).default(() => []), { reducer: concat }),
  evidencias: new ReducedValue(z.array(z.any()).default(() => []), { reducer: mergeEvidence }),
  trace: new ReducedValue(z.array(z.string()).default(() => []), { reducer: concat }),
  // consultas em que TODOS os provedores deram erro (falha técnica, não falta de dados)
  falhasBusca: new ReducedValue(z.array(z.string()).default(() => []), { reducer: concat }),
  juizo: z.any().default(null),
  resultado: z.any().default(null),
  inicio: z.number().default(0),
});

const PLAN_SYSTEM = () => `Você planeja buscas para checar uma afirmação feita em um debate no Brasil. Data de hoje: ${todayPtBR()}.
Gere consultas curtas (3 a 8 palavras), em português, mirando a FONTE PRIMÁRIA do dado (ex.: "IBGE PNAD desemprego 2026",
"Banco Central IPCA acumulado 12 meses"). Inclua o período quando relevante. Não repita consultas já feitas.`;

const JUDGE_SYSTEM = () => `Você é um checador de fatos profissional e apartidário trabalhando AO VIVO. Data de hoje: ${todayPtBR()}.
Julgue a afirmação USANDO SOMENTE as evidências fornecidas (E1, E2…), que vêm de fontes oficiais, científicas, de agências e de checadores.
Nunca use conhecimento próprio como base do veredito.

Critérios:
- VERDADEIRO: as evidências confirmam; arredondamentos razoáveis (até ~10%) e linguagem coloquial são aceitos.
- IMPRECISO: há base real, mas número distorcido, período/recorte errado, falta de contexto essencial ou conclusão exagerada.
- FALSO: as evidências contradizem a afirmação.
- SEM_EVIDENCIA: evidências insuficientes, afirmação inverificável ou fontes confiáveis divergentes sem consenso.

Atenção ao período: dado correto de outro ano/recorte não torna a afirmação verdadeira.
Prefira fonte primária a reportagem sobre ela.
Mesmo rigor para qualquer orador ou posição; avalie só o fato.
A transcrição é automática: se um erro de reconhecimento for evidente, considere a leitura mais provável e mencione.
Em "evidencias_usadas" liste só os IDs que de fato sustentam o veredito.
Marque precisa_mais_busca=true apenas se uma busca mais específica provavelmente resolveria (descreva a lacuna).
Se a afirmação for vaga demais para ser medida (ex.: "nenhum estado resolveu", "só sobe"), diga isso no resumo e aponte o dado mais próximo que as evidências trazem, se houver.
Escreva para o público do debate, não para um sistema: nunca use expressões como "evidências fornecidas" ou "material disponível". Sem dados, diga por exemplo "As fontes oficiais consultadas não trazem dados sobre…".
Português do Brasil, frases curtas — o resultado aparece em tela durante o debate.`;

const fmtEvidence = (ev) => ev.map((e) =>
  `[${e.id}] ${e.title}\nURL: ${e.url}\nTrecho: ${e.snippet}`).join('\n\n');

/**
 * Grafo de checagem:
 *
 *   START → cache ─┬─(hit)──────────────────────────────► END
 *                  └─► planejar ─(Send ×N)─► buscar ─► julgar ─┬─(lacuna e rodada < max)─► planejar
 *                                 └─(sem consultas)──► julgar  └─► validar ─► END
 *
 * @param {object} deps injeção para testes / troca de provedores
 * @param {{invoke}} [deps.planner]  cadeia estruturada (PlanSchema)
 * @param {{invoke}} [deps.judge]    cadeia estruturada (VerdictSchema)
 * @param {(q:string)=>Promise<{evidence, trace}>} [deps.search]
 */
export function buildCheckGraph(deps = {}) {
  const planner = deps.planner ?? structuredChain(config.llm.fast, PlanSchema, 'planejar_buscas');
  const judge = deps.judge ?? structuredChain(config.llm.judge, VerdictSchema, 'emitir_veredito');
  const search = deps.search ?? ((q) => runSearch(q));
  const maxRounds = deps.maxRounds ?? config.search.maxRounds;
  const maxQueries = deps.maxQueries ?? config.search.maxQueries;

  const cache = (s) => {
    const hit = verdictCache.get(normalizeText(s.afirmacao));
    return hit ? { resultado: { ...hit, cache: true } } : { inicio: Date.now() };
  };

  const planejar = async (s) => {
    const user = [
      `AFIRMAÇÃO: "${s.afirmacao}"`,
      s.orador && `Orador: ${s.orador}`,
      s.contexto && `Contexto: ${s.contexto}`,
      s.consultasFeitas.length && `Consultas já feitas: ${s.consultasFeitas.join(' | ')}`,
      s.evidencias.length && `Fontes já encontradas: ${s.evidencias.map((e) => e.title).join(' | ')}`,
      s.juizo?.lacuna && `Lacuna a resolver: ${s.juizo.lacuna}`,
    ].filter(Boolean).join('\n');
    const r = await planner.invoke([{ role: 'system', content: PLAN_SYSTEM() }, { role: 'user', content: user }]);
    const done = new Set(s.consultasFeitas.map(normalizeText));
    const consultas = [];
    for (const q of (r.data?.consultas ?? []).map((x) => String(x).trim())) {
      const k = normalizeText(q);
      if (!q || done.has(k)) continue;
      done.add(k);
      consultas.push(q);
      if (consultas.length === maxQueries) break;
    }
    return { consultas, rodada: s.rodada + 1, trace: [`planejar (${r.provider}:${r.model}): ${consultas.join(' | ') || '—'}`] };
  };

  const buscar = async (s) => {
    let evidence = [], trace = [];
    try {
      ({ evidence, trace } = await search(s.consulta));
    } catch (e) {
      trace = [`erro — ${e.message}`];
    }
    const allFailed = evidence.length === 0 && trace.length > 0 && trace.every((t) => / erro — |^erro — /.test(t));
    return {
      evidencias: evidence,
      consultasFeitas: [s.consulta],
      trace: trace.map((t) => `buscar "${s.consulta}" → ${t}`),
      falhasBusca: allFailed ? [trace.join(' | ')] : [],
    };
  };

  const julgar = async (s) => {
    const user = [
      `AFIRMAÇÃO: "${s.afirmacao}"`,
      s.orador && `Dita por: ${s.orador}`,
      s.contexto && `Contexto da fala: ${s.contexto}`,
      `EVIDÊNCIAS:\n${s.evidencias.length ? fmtEvidence(s.evidencias) : '(nenhuma evidência encontrada nas fontes confiáveis)'}`,
    ].filter(Boolean).join('\n\n');
    const r = await judge.invoke([{ role: 'system', content: JUDGE_SYSTEM() }, { role: 'user', content: user }]);
    return { juizo: { ...r.data, _provedor: `${r.provider}:${r.model}` }, trace: [`julgar (${r.provider}:${r.model}): ${r.data?.veredito}`] };
  };

  /** Regras determinísticas — a última palavra não é do LLM */
  const validar = (s) => {
    // Falha técnica em todas as buscas: não é veredito, é erro (e não vai para o cache)
    if (s.evidencias.length === 0 && s.consultasFeitas.length > 0 && s.falhasBusca.length >= s.consultasFeitas.length) {
      return {
        resultado: {
          afirmacao: s.afirmacao, orador: s.orador, veredito: 'SEM_EVIDENCIA', confianca: 0,
          falha_tecnica: `A busca falhou em todos os provedores: ${s.falhasBusca[0]}`,
          resumo: '', explicacao: '', dado_correto: '', fontes: [], buscas: s.consultasFeitas,
          rodadas: s.rodada, modelo: s.juizo?._provedor || '', avisos: [], trace: s.trace,
          ms: Date.now() - (s.inicio || Date.now()), checado_em: new Date().toISOString(),
        },
      };
    }
    const j = s.juizo ?? {};
    const byId = new Map(s.evidencias.map((e) => [e.id, e]));
    const usadas = [...new Set(j.evidencias_usadas ?? [])].map((id) => byId.get(String(id).trim())).filter(Boolean);
    const avisos = [];

    let veredito = VEREDITOS.includes(j.veredito) ? j.veredito : 'SEM_EVIDENCIA';
    let confianca = Math.round(Math.max(0, Math.min(100, Number(j.confianca) || 0)));
    const invalidos = (j.evidencias_usadas ?? []).length - usadas.length;
    if (invalidos > 0) avisos.push(`${invalidos} referência(s) a evidência inexistente descartada(s).`);
    if (veredito !== 'SEM_EVIDENCIA' && usadas.length === 0) {
      avisos.push('Nenhuma evidência de fonte confiável sustentou o veredito — rebaixado para SEM_EVIDENCIA.');
      veredito = 'SEM_EVIDENCIA';
      confianca = Math.min(confianca, 30);
    }

    const resultado = {
      afirmacao: s.afirmacao,
      orador: s.orador,
      veredito,
      confianca,
      resumo: j.resumo || '',
      explicacao: j.explicacao || '',
      dado_correto: j.dado_correto || '',
      fontes: usadas.map((e) => ({ id: e.id, url: e.url, titulo: e.title, trecho: e.snippet.slice(0, 280), provedor: e.provider })),
      buscas: s.consultasFeitas,
      rodadas: s.rodada,
      modelo: j._provedor || '',
      avisos,
      trace: s.trace,
      ms: Date.now() - (s.inicio || Date.now()),
      checado_em: new Date().toISOString(),
    };
    if (s.evidencias.length > 0) verdictCache.set(normalizeText(s.afirmacao), resultado); // sem fontes: tenta de novo na próxima
    return { resultado };
  };

  return new StateGraph(CheckState)
    .addNode('cache', cache)
    .addNode('planejar', planejar)
    .addNode('buscar', buscar)
    .addNode('julgar', julgar)
    .addNode('validar', validar)
    .addEdge(START, 'cache')
    .addConditionalEdges('cache', (s) => (s.resultado ? END : 'planejar'))
    .addConditionalEdges('planejar', (s) =>
      s.consultas.length ? s.consultas.map((q) => new Send('buscar', { ...s, consulta: q })) : 'julgar')
    .addConditionalEdges('buscar', (s) =>
      (s.evidencias.length === 0 && s.falhasBusca.length >= s.consultasFeitas.length ? 'validar' : 'julgar'))
    .addConditionalEdges('julgar', (s) =>
      (s.juizo?.precisa_mais_busca && s.rodada < maxRounds ? 'planejar' : 'validar'))
    .addEdge('validar', END)
    .compile();
}
