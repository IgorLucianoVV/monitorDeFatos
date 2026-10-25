import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.ANTHROPIC_API_KEY = 'test';
process.env.OPENAI_API_KEY = 'test';
process.env.DEEPGRAM_API_KEY = 'test';
process.env.ACCESS_TOKEN = '';

const { isTrustedUrl, trustedHosts } = await import('../src/config.js');
const { sanitize, runSearch } = await import('../src/providers/search/index.js');
const { _internals: oaSearch } = await import('../src/providers/search/openai.js');
const { buildCheckGraph, verdictCache } = await import('../src/graph/check.js');
const { buildExtractGraph } = await import('../src/graph/extract.js');
const { usableSpecs, parseSpec } = await import('../src/providers/llm.js');
const { groupBySpeaker, attachDeepgramProxy } = await import('../src/providers/transcription/deepgram.js');
const { transcribeDiarized, _internals: oaTr } = await import('../src/providers/transcription/openai.js');
const { createApp } = await import('../src/server.js');
const { default: WebSocket, WebSocketServer } = await import('ws');

beforeEach(() => verdictCache.clear());

// ---------------- fontes ----------------
test('isTrustedUrl: domínios, subdomínios, paths e protocolo', () => {
  assert.ok(isTrustedUrl('https://www.ibge.gov.br/estatisticas/x.html'));
  assert.ok(isTrustedUrl('https://agenciadenoticias.ibge.gov.br/a'));
  assert.ok(isTrustedUrl('https://g1.globo.com/fato-ou-fake/noticia/x.ghtml'));
  assert.ok(!isTrustedUrl('https://g1.globo.com/politica/x.ghtml'));
  assert.ok(!isTrustedUrl('https://gov.br.evil.com/x'));
  assert.ok(!isTrustedUrl('ftp://ibge.gov.br/x'));
  assert.ok(trustedHosts().includes('g1.globo.com'));
});

test('sanitize: filtra domínio, trecho curto e funde duplicatas', () => {
  const out = sanitize([
    { url: 'https://www.ibge.gov.br/a', title: 'A', snippet: 'Taxa de desocupação foi de 6,1% no trimestre.' },
    { url: 'https://ibge.gov.br/a/', title: 'A', snippet: 'Recorde da série histórica iniciada em 2012.' },
    { url: 'https://blog.com/x', title: 'B', snippet: 'qualquer coisa longa o bastante aqui' },
    { url: 'https://who.int/x', title: 'C', snippet: 'curto' },
  ], 'p');
  assert.equal(out.length, 1);
  assert.match(out[0].snippet, /6,1%.*….*2012/);
});

test('runSearch: fallback pula provedor com erro/vazio; merge junta', async () => {
  const ok = [{ url: 'https://ibge.gov.br/x', title: 'X', snippet: 'Dado oficial com conteúdo suficiente.' }];
  const registry = {
    a: { search: async () => { throw new Error('caiu'); } },
    b: { search: async () => [] },
    c: { search: async () => ok },
    d: { search: async () => [{ url: 'https://who.int/y', title: 'Y', snippet: 'Outro dado oficial com conteúdo.' }] },
  };
  const f = await runSearch('q', { providers: ['a', 'b', 'c', 'd'], mode: 'fallback', registry });
  assert.equal(f.evidence.length, 1);
  assert.equal(f.evidence[0].provider, 'c');
  assert.match(f.trace[0], /a: erro/);
  const m = await runSearch('q', { providers: ['c', 'd'], mode: 'merge', registry });
  assert.deepEqual(m.evidence.map((e) => e.provider).sort(), ['c', 'd']);
});

test('openai search: trecho expandido até a frase', () => {
  const t = 'Intro. A taxa foi de 6,1% em 2026 segundo o IBGE. Outra frase.';
  const i = t.indexOf('6,1%');
  assert.equal(oaSearch.sentenceAround(t, i, i + 4), 'A taxa foi de 6,1% em 2026 segundo o IBGE.');
});

test('llm: specs sem chave são ignoradas', () => {
  assert.deepEqual(parseSpec('openai:gpt-5.5'), { provider: 'openai', model: 'gpt-5.5' });
  const u = usableSpecs(['anthropic:a', 'google:g', 'desconhecido:x', 'openai:o']);
  assert.deepEqual(u.map((s) => s.provider), ['anthropic', 'openai']);
});

// ---------------- grafo de checagem ----------------
const fake = (fn) => ({ invoke: async (msgs) => ({ data: await fn(msgs), provider: 'fake', model: 'm' }) });
const EV = (url, snippet) => ({ url, title: url, snippet, provider: 'fake' });

test('grafo: fan-out de consultas, 2 rodadas, IDs válidos e inválidos', async () => {
  const searched = [];
  let judgeCalls = 0;
  const g = buildCheckGraph({
    maxRounds: 2,
    planner: fake((m) => ({ consultas: m[1].content.includes('Lacuna') ? ['ipca 2026 bcb'] : ['desemprego ibge', 'pnad 2026', 'desemprego ibge'] })),
    search: async (q) => { searched.push(q); return { evidence: [EV(`https://ibge.gov.br/${encodeURIComponent(q)}`, `trecho sobre ${q} com conteúdo`)], trace: ['fake: 1'] }; },
    judge: fake(() => (++judgeCalls === 1
      ? { veredito: 'SEM_EVIDENCIA', confianca: 20, resumo: '', explicacao: '', dado_correto: '', evidencias_usadas: [], precisa_mais_busca: true, lacuna: 'inflação' }
      : { veredito: 'IMPRECISO', confianca: 85, resumo: 'r', explicacao: 'e', dado_correto: 'd', evidencias_usadas: ['E1', 'E3', 'E99'], precisa_mais_busca: false, lacuna: '' })),
  });
  const out = await g.invoke({ afirmacao: 'O desemprego está em 20 por cento', orador: 'A' });
  const r = out.resultado;
  assert.equal(r.veredito, 'IMPRECISO');
  assert.equal(judgeCalls, 2);
  assert.equal(r.rodadas, 2);
  assert.deepEqual(new Set(searched), new Set(['desemprego ibge', 'pnad 2026', 'ipca 2026 bcb']));
  assert.equal(searched.length, 3, 'consultas duplicadas não vão para a busca');
  assert.deepEqual(r.fontes.map((f) => f.id), ['E1', 'E3']);
  assert.match(r.avisos.join(' '), /inexistente/);
});

test('grafo: veredito sem evidência citada vira SEM_EVIDENCIA e não entra no cache', async () => {
  let searches = 0;
  const g = buildCheckGraph({
    planner: fake(() => ({ consultas: ['x'] })),
    search: async () => { searches++; return { evidence: [], trace: ['openai: 0 evidência(s) em 5ms'] }; },
    judge: fake(() => ({ veredito: 'FALSO', confianca: 95, resumo: 'r', explicacao: 'e', dado_correto: '', evidencias_usadas: ['E1'], precisa_mais_busca: false, lacuna: '' })),
  });
  const a = (await g.invoke({ afirmacao: 'A inflação de 2025 foi a maior da história' })).resultado;
  assert.equal(a.veredito, 'SEM_EVIDENCIA');
  assert.ok(a.confianca <= 30);
  assert.equal(a.falha_tecnica, undefined);
  const b = (await g.invoke({ afirmacao: 'A inflação de 2025 foi a maior da história!' })).resultado;
  assert.notEqual(b.cache, true);
  assert.equal(searches, 2);
});

test('grafo: com evidência o resultado vai para o cache', async () => {
  let searches = 0;
  const g = buildCheckGraph({
    planner: fake(() => ({ consultas: ['x'] })),
    search: async () => { searches++; return { evidence: [EV('https://ibge.gov.br/x', 'dado oficial com conteúdo')], trace: [] }; },
    judge: fake(() => ({ veredito: 'VERDADEIRO', confianca: 80, resumo: 'r', explicacao: 'e', dado_correto: '', evidencias_usadas: ['E1'], precisa_mais_busca: false, lacuna: '' })),
  });
  await g.invoke({ afirmacao: 'O IBGE divulgou a taxa de desocupação' });
  const b = (await g.invoke({ afirmacao: 'O IBGE divulgou a taxa de desocupação.' })).resultado;
  assert.equal(b.cache, true);
  assert.equal(searches, 1);
});

test('grafo: falha técnica em todas as buscas vira erro, sem chamar o juiz', async () => {
  let judged = 0;
  const g = buildCheckGraph({
    planner: fake(() => ({ consultas: ['a', 'b'] })),
    search: async () => ({ evidence: [], trace: ['openai: erro — 400 invalid domain'] }),
    judge: fake(() => { judged++; return {}; }),
  });
  const r = (await g.invoke({ afirmacao: 'A Constituição define a segurança pública' })).resultado;
  assert.equal(judged, 0);
  assert.match(r.falha_tecnica, /400 invalid domain/);
});

test('openai search: citação depois do ponto final usa a frase anterior', () => {
  const t = 'A carga foi de 32,3% do PIB em 2024, segundo o Tesouro. ([tesouro.gov.br](https://tesouro.gov.br/x?utm_source=openai))';
  const i = t.indexOf('[tesouro');
  assert.equal(oaSearch.citedSnippet(t, i, t.length - 1), 'A carga foi de 32,3% do PIB em 2024, segundo o Tesouro.');
});

test('trustedHosts: sufixos públicos ganham órgãos explícitos', () => {
  const h = trustedHosts();
  for (const x of ['gov.br', 'planalto.gov.br', 'ibge.gov.br', 'camara.leg.br', 'stf.jus.br']) assert.ok(h.includes(x), x);
  assert.ok(h.length <= 100);
});

test('grafo: limite de rodadas mesmo se o juiz sempre pedir mais', async () => {
  let n = 0;
  const g = buildCheckGraph({
    maxRounds: 2,
    planner: fake(() => ({ consultas: [`q${++n}`] })),
    search: async (q) => ({ evidence: [EV(`https://who.int/${q}`, `conteúdo da evidência ${q}`)], trace: [] }),
    judge: fake(() => ({ veredito: 'VERDADEIRO', confianca: 70, resumo: '', explicacao: '', dado_correto: '', evidencias_usadas: ['E2'], precisa_mais_busca: true, lacuna: 'mais' })),
  });
  const r = (await g.invoke({ afirmacao: 'A OMS declarou algo verificável aqui' })).resultado;
  assert.equal(r.rodadas, 2);
  assert.equal(r.veredito, 'VERDADEIRO');
  assert.equal(r.fontes[0].url, 'https://who.int/q2');
});

test('grafo de extração: dedupe contra já checadas e entre si', async () => {
  const g = buildExtractGraph({
    extractor: fake(() => ({ afirmacoes: [
      { texto: 'O Brasil tem 213 milhões de habitantes segundo o IBGE', trecho_original: 'x', categoria: 'estatistica' },
      { texto: 'O Brasil tem 213 milhões de habitantes, segundo IBGE', trecho_original: 'x', categoria: 'estatistica' },
      { texto: 'A taxa Selic está em 15 por cento ao ano', trecho_original: 'y', categoria: 'economia' },
      { texto: 'curta', trecho_original: 'z', categoria: 'outro' },
    ] })),
  });
  const out = await g.invoke({ novo: 'trecho qualquer da fala', jaChecadas: ['taxa Selic está em 15 por cento ao ano'] });
  assert.deepEqual(out.afirmacoes.map((a) => a.texto), ['O Brasil tem 213 milhões de habitantes segundo o IBGE']);
});

// ---------------- transcrição ----------------
test('deepgram: agrupa palavras por orador', () => {
  const segs = groupBySpeaker([
    { word: 'a', punctuated_word: 'A', speaker: 0 }, { word: 'b', punctuated_word: 'inflação.', speaker: 0 },
    { word: 'c', punctuated_word: 'Não', speaker: 1 }, { word: 'd', punctuated_word: 'é.', speaker: 1 },
  ]);
  assert.deepEqual(segs, [{ speaker: 'dg:0', text: 'A inflação.' }, { speaker: 'dg:1', text: 'Não é.' }]);
});

test('openai diarize: rótulos consistentes entre trechos via referências', async () => {
  const calls = [];
  const responses = [
    { segments: [{ speaker: 'A', text: 'Olá', start: 0, end: 4 }, { speaker: 'B', text: 'Oi', start: 4, end: 5 }, { speaker: 'A', text: 'tudo', start: 5, end: 6 }] },
    { segments: [{ speaker: 'orador_1', text: 'De novo', start: 0, end: 2 }, { speaker: 'A', text: 'Novo', start: 2, end: 6 }] },
  ];
  oaTr.setClient({ audio: { transcriptions: { create: async (p) => { calls.push(p); return responses.shift(); } } } });
  const cut = async () => 'data:audio/wav;base64,AAA';
  const r1 = await transcribeDiarized(Buffer.alloc(5000), 'audio/webm', 'sess', { cut });
  assert.deepEqual(r1.map((s) => s.speaker), ['orador_1', 'orador_2', 'orador_1']);
  const r2 = await transcribeDiarized(Buffer.alloc(5000), 'audio/webm', 'sess', { cut });
  // orador_2 tinha só 1 s → sem referência; "A" do 2º trecho vira orador novo
  assert.deepEqual(calls[1].known_speaker_names, ['orador_1']);
  assert.deepEqual(r2.map((s) => s.speaker), ['orador_1', 'orador_3']);
});

test('proxy deepgram: repassa áudio e converte resultados com oradores', async () => {
  const fakeDg = new WebSocketServer({ port: 0 });
  const gotAudio = [];
  fakeDg.on('connection', (s) => {
    s.on('message', (d, bin) => {
      if (bin) { gotAudio.push(d.length); s.send(JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'x y', words: [{ punctuated_word: 'Sim.', speaker: 0 }, { punctuated_word: 'Não.', speaker: 1 }] }] } })); }
      else if (JSON.parse(d).type === 'CloseStream') s.close();
    });
  });
  const server = http.createServer();
  attachDeepgramProxy(server, { connect: () => new WebSocket(`ws://localhost:${fakeDg.address().port}`) });
  await new Promise((r) => server.listen(0, r));
  const ws = new WebSocket(`ws://localhost:${server.address().port}/ws/deepgram`);
  const msgs = [];
  await new Promise((resolve) => {
    ws.on('open', () => ws.send(Buffer.alloc(300)));
    ws.on('message', (m) => {
      const d = JSON.parse(m); msgs.push(d);
      if (d.type === 'final') ws.send(JSON.stringify({ type: 'stop' }));
    });
    ws.on('close', resolve);
  });
  assert.equal(gotAudio[0], 300);
  const fin = msgs.find((m) => m.type === 'final');
  assert.deepEqual(fin.segments, [{ speaker: 'dg:0', text: 'Sim.' }, { speaker: 'dg:1', text: 'Não.' }]);
  server.close(); fakeDg.close();
});

// ---------------- HTTP ----------------
test('POST /api/check transmite etapas em NDJSON e o resultado', async () => {
  const checkGraph = buildCheckGraph({
    planner: fake(() => ({ consultas: ['a', 'b'] })),
    search: async (q) => ({ evidence: [EV(`https://ibge.gov.br/${q}`, `conteúdo da evidência ${q}`)], trace: [] }),
    judge: fake(() => ({ veredito: 'VERDADEIRO', confianca: 90, resumo: 'ok', explicacao: 'e', dado_correto: '', evidencias_usadas: ['E1'], precisa_mais_busca: false, lacuna: '' })),
  });
  const server = http.createServer(createApp({ checkGraph }));
  await new Promise((r) => server.listen(0, r));
  const res = await fetch(`http://localhost:${server.address().port}/api/check`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texto: 'A população do Brasil é de 213 milhões' }),
  });
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  server.close();
  assert.deepEqual(lines.map((l) => l.etapa || l.type), ['planejar', 'buscar', 'buscar', 'julgar', 'resultado']);
  assert.equal(lines.at(-1).data.veredito, 'VERDADEIRO');
});
