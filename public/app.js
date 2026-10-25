// =====================================================================
// Checagem ao vivo — front-end
// =====================================================================
const ANALYZE_MIN_WORDS = 30;      // analisa quando acumula N palavras…
const ANALYZE_MAX_WAIT_MS = 12000; // …ou após este tempo com pelo menos 8 palavras
const CHUNK_MS = { whisper: 9000, 'openai-diarize': 12000 };
const CHECK_CONCURRENCY = 3;
const LOWER_THIRD_MS = 12000;
const COLORS = ['#f5c542', '#5ab0ff', '#f27ab8', '#b39bff', '#4cc38a', '#ff9a52', '#ff6b5f', '#9fb0c4'];

const VERDICT = {
  VERDADEIRO: { label: 'Verdadeiro', icon: '✓' },
  IMPRECISO: { label: 'Impreciso', icon: '≈' },
  FALSO: { label: 'Falso', icon: '✕' },
  SEM_EVIDENCIA: { label: 'Sem evidência', icon: '?' },
};
const ENGINES = {
  deepgram: { name: 'Tempo real com oradores automáticos', desc: 'Deepgram. Menor atraso; separa quem fala durante todo o debate.', auto: true, key: 'Deepgram' },
  'openai-diarize': { name: 'Trechos com oradores automáticos', desc: 'OpenAI. Atraso de ~12 s; mantém os mesmos oradores entre trechos.', auto: true, key: 'OpenAI' },
  whisper: { name: 'Trechos sem separar oradores', desc: 'OpenAI Whisper. Você indica quem está falando pelas teclas 1–9.', auto: false, key: 'OpenAI' },
  browser: { name: 'Reconhecimento do navegador', desc: 'Grátis, só microfone, Chrome/Edge. Você indica quem está falando.', auto: false, key: null },
};
const AUTO_ENGINES = new Set(Object.keys(ENGINES).filter((k) => ENGINES[k].auto));
const ENGINE_ORDER = ['deepgram', 'openai-diarize', 'whisper', 'browser'];

// ---------------------------------------------------------------- estado
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const state = {
  token: sessionStorage.getItem('fc_token') || '',
  health: null,
  avail: {},
  engine: store.get('fc_engine') || null,
  source: 'tab',
  running: false,
  activeEngine: null,
  speakers: new Map(), manualSpk: 'm:1', autoCount: 0,
  segs: [], segSeq: 0,
  pending: '', pendingSince: 0, pendingSpk: null, pendingSegIds: [],
  checked: [], claimTexts: [], queue: [], active: 0,
  diarizeSession: null,
};

const $ = (s, r = document) => r.querySelector(s);
const el = {
  live: $('#live'), liveText: $('#liveText'), runHint: $('#runHint'),
  btnRun: $('#btnRun'), fileInput: $('#fileInput'),
  screen: $('#screen'), video: $('#video'), lowerThird: $('#lowerThird'), checkingPill: $('#checkingPill'),
  levelBar: $('#levelBar'), engineChip: $('#engineChip'), stepKeys: $('#stepKeys'), stepKeysText: $('#stepKeysText'),
  speakers: $('#speakers'), spkHint: $('#spkHint'),
  transcript: $('#transcript'), transcriptEmpty: $('#transcriptEmpty'), interim: $('#interim'),
  cards: $('#cards'), cardsEmpty: $('#cardsEmpty'), queueInfo: $('#queueInfo'),
  manual: $('#manual'), manualInput: $('#manualInput'), toasts: $('#toasts'),
};

// ---------------------------------------------------------------- util
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const clock = (d = new Date()) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9% ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
function similar(a, b) {
  const A = new Set(norm(a)), B = new Set(norm(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : '#'; } catch { return '#'; } };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// ---------------------------------------------------------------- feedback (status, avisos)
function setLive(kind, text) { el.live.dataset.state = kind; el.liveText.textContent = text; }

/** Aviso com causa e correção (Nielsen #9). kind: info | ok | error */
function toast(title, detail = '', kind = 'info', ms = 7000) {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `<div><b></b><p></p></div><button class="btn quiet icon small" aria-label="Fechar aviso">✕</button>`;
  t.querySelector('b').textContent = title;
  const p = t.querySelector('p'); detail ? (p.textContent = detail) : p.remove();
  t.querySelector('button').addEventListener('click', () => t.remove());
  el.toasts.appendChild(t);
  if (ms) setTimeout(() => t.remove(), ms);
  while (el.toasts.children.length > 3) el.toasts.firstElementChild.remove();
}

// ---------------------------------------------------------------- API
const authHeaders = () => (state.token ? { 'x-access-token': state.token } : {});
async function api(path, { json, form, method = 'POST' } = {}) {
  const headers = authHeaders();
  if (json) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: json ? JSON.stringify(json) : form });
  return readJson(res);
}

const OUTDATED = 'O servidor está rodando uma versão antiga do código. Pare o servidor (Ctrl + C no terminal), rode npm start de novo e recarregue a página.';

/** Lê a resposta como JSON e traduz os casos comuns em mensagens que dizem o que fazer */
async function readJson(res) {
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  if (res.status === 401) { askToken(); throw new Error('Token de acesso inválido'); }
  if (!isJson) throw new Error(res.status === 404 ? OUTDATED : `Resposta inesperada do servidor (HTTP ${res.status})`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function askToken() {
  const t = prompt('Este servidor exige um token de acesso. Digite o token:');
  if (t) { state.token = t.trim(); sessionStorage.setItem('fc_token', state.token); }
}

// ---------------------------------------------------------------- disponibilidade (prevenção de erros)
async function refreshHealth() {
  const h = await (await fetch('/api/health')).json();
  state.health = h;
  state.avail = {
    deepgram: h.transcription.deepgram,
    'openai-diarize': h.transcription.openaiDiarize,
    whisper: h.transcription.whisper,
    browser: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
  };
  if (!state.engine || !state.avail[state.engine]) state.engine = ENGINE_ORDER.find((k) => state.avail[k]) || 'browser';
  updateReadiness();
  return h;
}

/** O que falta para iniciar, em linguagem do usuário */
function missingSetup() {
  const h = state.health;
  if (!h) return 'Servidor indisponível. Verifique se o npm start está rodando.';
  if (!h.llm.judge.length) return 'Cadastre a chave de um modelo de IA (Anthropic, OpenAI ou Google) em Configurações.';
  if (!h.search.providers.length) return 'Cadastre a chave de um provedor de busca (Anthropic, OpenAI ou Tavily) em Configurações.';
  return '';
}

/** Motor efetivo para a fonte escolhida (o reconhecimento do navegador só ouve o microfone) */
function engineFor(source) {
  if (source === 'mic' || state.engine !== 'browser') return state.avail[state.engine] ? state.engine : null;
  return ENGINE_ORDER.find((k) => k !== 'browser' && state.avail[k]) || null;
}

function updateReadiness() {
  const missing = missingSetup();
  el.stepKeys.classList.toggle('done', !missing);
  el.stepKeysText.textContent = missing ? 'Pelo menos um modelo de IA e um provedor de busca.' : 'Pronto. Você pode trocar as chaves em Configurações.';
  let hint = missing;
  if (!hint && !state.running && !engineFor(state.source)) {
    hint = 'Para analisar transmissão ou arquivo, cadastre a chave da Deepgram ou da OpenAI em Configurações (ou escolha Microfone).';
  }
  el.runHint.textContent = state.running ? '' : hint;
  el.btnRun.disabled = !state.running && Boolean(hint);
  const eng = state.running ? state.activeEngine : engineFor(state.source);
  el.engineChip.textContent = eng ? `Transcrição: ${ENGINES[eng].name.toLowerCase()}` : '';
  updateSpeakerHint();
}

// ---------------------------------------------------------------- oradores
function ensureSpeaker(id, { name, auto = true } = {}) {
  if (state.speakers.has(id)) return state.speakers.get(id);
  const sp = { name: name || `Orador ${++state.autoCount}`, color: COLORS[state.speakers.size % COLORS.length], auto };
  state.speakers.set(id, sp);
  addSpeakerChip(id, sp);
  if (auto) updateSpeakerHint();
  return sp;
}
const manualIds = () => [...state.speakers].filter(([, s]) => !s.auto).map(([id]) => id);

function addSpeakerChip(id, sp) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `spk${sp.auto ? ' auto' : ''}${id === state.manualSpk ? ' active' : ''}`;
  b.dataset.id = id;
  b.style.setProperty('--c', sp.color);
  const keyIdx = sp.auto ? -1 : manualIds().indexOf(id);
  b.title = sp.auto ? 'Detectado automaticamente. Clique no nome para renomear.' : 'Clique para marcar como quem está falando. Clique no nome para renomear.';
  b.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="name" contenteditable="true" spellcheck="false" aria-label="Nome do orador"></span>${keyIdx >= 0 && keyIdx < 9 ? `<span class="key" aria-label="atalho">${keyIdx + 1}</span>` : ''}`;
  const nameEl = $('.name', b);
  nameEl.textContent = sp.name;
  nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } e.stopPropagation(); });
  nameEl.addEventListener('blur', () => renameSpeaker(id, nameEl.textContent));
  b.addEventListener('click', (e) => { if (!sp.auto && e.target !== nameEl) selectManual(id); });
  el.speakers.appendChild(b);
}

function renameSpeaker(id, name) {
  const sp = state.speakers.get(id);
  name = name.trim().slice(0, 40);
  if (!sp || !name || name === sp.name) return;
  sp.name = name;
  document.querySelectorAll(`[data-sp="${CSS.escape(id)}"]`).forEach((n) => { n.textContent = name; });
}

function selectManual(id) {
  if (id === state.manualSpk) return;
  if (!AUTO_ENGINES.has(state.activeEngine)) flushPending();
  state.manualSpk = id;
  el.speakers.querySelectorAll('.spk').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
}

function flashTalking(id) {
  const b = el.speakers.querySelector(`.spk[data-id="${CSS.escape(id)}"]`);
  if (!b) return;
  b.classList.add('talking');
  clearTimeout(b._t); b._t = setTimeout(() => b.classList.remove('talking'), 1500);
}

function updateSpeakerHint() {
  const eng = state.running ? state.activeEngine : engineFor(state.source);
  const auto = AUTO_ENGINES.has(eng);
  el.spkHint.closest('.speakers-row').dataset.auto = String(auto);
  el.spkHint.textContent = auto
    ? (state.speakers.size > manualIds().length ? 'Oradores detectados (clique no nome para renomear)' : 'Os oradores serão detectados automaticamente')
    : 'Quem está falando (teclas 1–9)';
}

ensureSpeaker('m:1', { name: 'Debatedor A', auto: false });
ensureSpeaker('m:2', { name: 'Debatedor B', auto: false });
$('#btnAddSpk').addEventListener('click', () => {
  ensureSpeaker(`m:${manualIds().length + 1}`, { name: `Debatedor ${String.fromCharCode(65 + manualIds().length)}`, auto: false });
});

// ---------------------------------------------------------------- transcrição
const canSeek = () => state.source === 'file' && el.video.src && Number.isFinite(el.video.duration);

function addSegment(text, spId = state.manualSpk, mediaTime = null) {
  text = (text || '').trim();
  if (!text) return;
  const sp = ensureSpeaker(spId);
  if (state.pending && state.pendingSpk !== spId) flushPending(); // cada análise pertence a um orador
  const seg = { id: ++state.segSeq, text, speaker: spId, ts: new Date(), mediaTime };
  state.segs.push(seg);
  flashTalking(spId);
  el.transcriptEmpty?.remove();

  const p = document.createElement('p');
  p.className = 'seg';
  p.id = `seg-${seg.id}`;
  p.style.setProperty('--c', sp.color);
  const when = mediaTime != null && state.source === 'file' ? mmss(mediaTime) : clock(seg.ts).slice(0, 5);
  p.innerHTML = `<time></time><span><span class="who"></span><span class="txt"></span></span>`;
  $('time', p).textContent = when;
  $('.who', p).textContent = sp.name; $('.who', p).dataset.sp = spId;
  $('.txt', p).textContent = text;
  if (mediaTime != null && state.source === 'file') {
    p.classList.add('seekable');
    p.title = 'Voltar o vídeo para este momento';
    p.addEventListener('click', () => seekTo(mediaTime));
  }
  const atBottom = el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 80;
  el.transcript.appendChild(p);
  if (atBottom) el.transcript.scrollTop = el.transcript.scrollHeight;

  if (!state.pending) { state.pendingSince = Date.now(); state.pendingSpk = spId; }
  state.pending += (state.pending ? ' ' : '') + text;
  state.pendingSegIds.push(seg.id);
  if (words(state.pending) >= ANALYZE_MIN_WORDS) flushPending();
}

function showInterim(text, spId) {
  if (!text) { el.interim.textContent = ''; return; }
  const sp = spId ? state.speakers.get(spId) : null;
  el.interim.innerHTML = `${sp ? `<span class="who" style="color:${sp.color}">${esc(sp.name)}</span>` : ''}${esc(text)}`;
}

function seekTo(t) {
  if (!canSeek()) return;
  el.video.currentTime = Math.max(0, t - 1);
}

setInterval(() => {
  if (state.pending && words(state.pending) >= 8 && Date.now() - state.pendingSince > ANALYZE_MAX_WAIT_MS) flushPending();
}, 2000);

function contextBefore(chars = 700) {
  const all = state.segs.map((s) => `${state.speakers.get(s.speaker)?.name}: ${s.text}`).join(' ');
  const cut = Math.max(0, all.length - state.pending.length);
  return all.slice(Math.max(0, cut - chars), cut);
}

async function flushPending() {
  const novo = state.pending.trim();
  if (!novo) return;
  const spId = state.pendingSpk;
  const orador = state.speakers.get(spId)?.name || '';
  const segIds = state.pendingSegIds.slice();
  const contexto = contextBefore();
  state.pending = ''; state.pendingSpk = null; state.pendingSegIds = [];
  if (words(novo) < 5) return;
  try {
    const { afirmacoes } = await api('/api/extract', { json: { novo, contexto, orador, jaChecadas: state.claimTexts.slice(-30) } });
    for (const a of afirmacoes) enqueue(a.texto, { spId, orador, contexto: `${contexto.slice(-300)} ${a.trecho_original || ''}`.trim(), segIds });
  } catch (err) {
    toast('Não foi possível analisar um trecho da fala', `${err.message}. A transcrição continua; o próximo trecho será analisado normalmente.`, 'error');
  }
}

// ---------------------------------------------------------------- fila de checagem
function enqueue(texto, { spId = null, orador = '', contexto = '', segIds = [], force = false } = {}) {
  if (!force && state.claimTexts.some((c) => similar(c, texto) >= 0.8)) return;
  state.claimTexts.push(texto);
  const job = { texto, spId, orador, contexto, segIds };
  job.card = createCard(job);
  state.queue.push(job);
  pump();
}

function pump() {
  while (state.active < CHECK_CONCURRENCY && state.queue.length) {
    const job = state.queue.shift();
    state.active++;
    runCheck(job)
      .catch((err) => failCard(job, err))
      .finally(() => { state.active--; updateQueue(); pump(); });
  }
  updateQueue();
}

function updateQueue() {
  const n = state.active + state.queue.length;
  el.queueInfo.textContent = n ? `${n} em checagem` : '';
  el.checkingPill.hidden = !n;
  el.checkingPill.textContent = n === 1 ? 'Checando 1 afirmação' : `Checando ${n} afirmações`;
}

const STEP_DETAIL = {
  planejar: (e) => (e.consultas?.length ? `Buscando: ${e.consultas.join(' · ')}` : 'Sem novas buscas; avaliando o que já foi encontrado'),
  buscar: (e) => `${e.evidencias} fonte(s) encontradas para “${e.consulta}”`,
  julgar: (e) => (e.maisBusca ? 'Evidência insuficiente; fazendo mais uma busca' : 'Conferindo as fontes citadas'),
};

async function runCheck(job) {
  const card = job.card;
  setCardState(card, 'Checando…');
  setStep(card, 'planejar');
  const res = await fetch('/api/check', {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ texto: job.texto, orador: job.orador, contexto: job.contexto }),
  });
  if (res.status === 401) { askToken(); throw new Error('Token de acesso inválido'); }
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += value || '';
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.type === 'etapa') {
        setStep(card, ev.etapa === 'julgar' && ev.maisBusca ? 'planejar' : ev.etapa);
        $('.progress-detail', card).textContent = STEP_DETAIL[ev.etapa]?.(ev) || '';
      }
      if (ev.type === 'resultado') { finishCheck(job, ev.data); return; }
      if (ev.type === 'erro') throw new Error(ev.error);
    }
    if (done) break;
  }
  throw new Error('A resposta do servidor foi interrompida');
}

function finishCheck(job, r) {
  if (r.falha_tecnica) { fillCard(job.card, r, job); return; }
  state.checked.push({ ...r, orador_id: job.spId });
  fillCard(job.card, r, job);
  updateCounts();
  showLowerThird(r, job.spId);
  // marca o trecho de origem na transcrição
  const seg = job.segIds[0] && document.getElementById(`seg-${job.segIds[0]}`);
  if (seg && VERDICT[r.veredito]) {
    const m = document.createElement('span');
    m.className = `mark ${r.veredito}`;
    m.textContent = VERDICT[r.veredito].icon;
    m.title = `${VERDICT[r.veredito].label}: ${r.afirmacao}`;
    $('.txt', seg).after(m);
  }
}

function updateCounts() {
  const c = { all: state.checked.length, VERDADEIRO: 0, IMPRECISO: 0, FALSO: 0, SEM_EVIDENCIA: 0 };
  state.checked.forEach((r) => { c[r.veredito] = (c[r.veredito] || 0) + 1; });
  document.querySelectorAll('[data-count]').forEach((b) => { b.textContent = c[b.dataset.count] ?? 0; });
}

document.querySelectorAll('input[name="filter"]').forEach((r) => r.addEventListener('change', () => { el.cards.dataset.filter = r.value; }));

// ---------------------------------------------------------------- cartões
function createCard(job) {
  el.cardsEmpty?.remove();
  const card = $('#cardTpl').content.firstElementChild.cloneNode(true);
  const sp = job.spId ? state.speakers.get(job.spId) : null;
  $('.claim', card).textContent = job.texto;
  const who = $('.who', card);
  who.textContent = job.orador || '';
  if (job.spId) { who.dataset.sp = job.spId; card.style.setProperty('--c', sp?.color); }
  const t = new Date();
  $('.time', card).textContent = clock(t).slice(0, 5);
  $('.time', card).dateTime = t.toISOString();
  card.setAttribute('aria-label', `Checagem: ${job.texto}`);
  card.addEventListener('click', (e) => { if (!e.target.closest('a, button, summary')) selectCard(job); });
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) selectCard(job); });
  $('[data-act="retry"]', card).addEventListener('click', () => {
    card.remove();
    state.claimTexts = state.claimTexts.filter((c) => similar(c, job.texto) < 0.8);
    enqueue(job.texto, { ...job, force: true });
  });
  el.cards.prepend(card);
  return card;
}

function setCardState(card, text) {
  $('.verdict .v-txt', card).textContent = text;
  $('.verdict .v-ico', card).textContent = '';
}

function setStep(card, step) {
  const order = ['planejar', 'buscar', 'julgar'];
  const idx = order.indexOf(step);
  card.querySelectorAll('.progress li').forEach((li, i) => {
    li.classList.toggle('done', i < idx);
    li.classList.toggle('active', i === idx);
  });
}

function fillCard(card, r, job) {
  if (r.falha_tecnica) return failCard(job, new Error(`${r.falha_tecnica}. Confira as chaves e use “Testar busca” em Configurações.`), r);
  const v = VERDICT[r.veredito] || VERDICT.SEM_EVIDENCIA;
  card.classList.remove('pending');
  card.classList.add(r.veredito);
  $('.verdict .v-ico', card).textContent = v.icon;
  $('.verdict .v-txt', card).textContent = v.label;
  $('.summary', card).textContent = r.resumo;
  $('.data', card).textContent = r.dado_correto ? `O que os dados dizem: ${r.dado_correto}` : '';
  // "confiança" num "sem evidência" confunde: só mostra quando há veredito
  $('.confidence', card).hidden = r.veredito === 'SEM_EVIDENCIA';
  $('.conf-label', card).textContent = `Confiança ${r.confianca}%`;
  $('.conf-bar span', card).style.width = `${r.confianca}%`;
  $('.sources', card).innerHTML = (r.fontes || []).map((f) => `
    <li>
      <a href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener noreferrer">${esc(f.titulo || f.url)}</a>
      <span class="host">${esc(hostOf(f.url))}</span>
      ${f.trecho ? `<span class="snip">“${esc(f.trecho)}”</span>` : ''}
    </li>`).join('');
  $('.warn', card).textContent = (r.avisos || []).join(' ');
  $('.explain', card).textContent = r.explicacao || '';
  const trace = [
    r.modelo && `Avaliado por ${r.modelo}${r.rodadas > 1 ? ` em ${r.rodadas} rodadas de busca` : ''}`,
    ...(r.trace || []).filter((t) => t.startsWith('buscar ')).map((t) => t.replace(/^buscar "([^"]*)" → /, 'Busca “$1”: ').replace('evidência(s)', 'fonte(s) válida(s)')),
    `Tempo: ${(r.ms / 1000).toFixed(1)} s${r.cache ? ' (já checada antes)' : ''}`,
  ].filter(Boolean);
  $('.trace', card).innerHTML = trace.map((t) => `<li>${esc(t)}</li>`).join('');
  card.setAttribute('aria-label', `${v.label}: ${r.afirmacao}`);
}

function failCard(job, err, r = null) {
  const card = job.card;
  if (r?.trace?.length) $('.trace', card).innerHTML = r.trace.filter((t) => t.startsWith('buscar ')).map((t) => `<li>${esc(t)}</li>`).join('');
  card.classList.remove('pending');
  card.classList.add('error');
  setCardState(card, 'Não checada');
  $('.summary', card).textContent = `A checagem falhou: ${err.message}`;
  $('.card-actions', card).hidden = false;
}

function selectCard(job) {
  el.cards.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
  job.card.classList.add('selected');
  const first = job.segIds.map((id) => document.getElementById(`seg-${id}`)).filter(Boolean);
  if (!first.length) return;
  first[0].scrollIntoView({ block: 'center' });
  first.forEach((s) => { s.classList.add('flash'); setTimeout(() => s.classList.remove('flash'), 2500); });
  const seg = state.segs.find((s) => s.id === job.segIds[0]);
  if (seg?.mediaTime != null) seekTo(seg.mediaTime);
}

// ---------------------------------------------------------------- tarja sobre o vídeo
let ltTimer = null;
function showLowerThird(r, spId) {
  if (el.screen.dataset.mode === 'empty') return;
  const v = VERDICT[r.veredito] || VERDICT.SEM_EVIDENCIA;
  const lt = el.lowerThird;
  lt.hidden = true; void lt.offsetWidth; // reinicia a animação
  lt.dataset.v = r.veredito;
  $('.v-ico', lt).textContent = v.icon;
  $('.v-txt', lt).textContent = v.label;
  const who = $('.lt-who', lt);
  who.textContent = r.orador || '';
  if (spId) who.dataset.sp = spId;
  $('.lt-claim', lt).textContent = r.afirmacao;
  $('.lt-sum', lt).textContent = r.resumo || '';
  lt.hidden = false;
  clearTimeout(ltTimer);
  ltTimer = setTimeout(() => { lt.hidden = true; }, LOWER_THIRD_MS);
}

// ---------------------------------------------------------------- captura de áudio
const pickMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  .find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';

function waitAudioTrack(stream, ms = 4000) {
  if (stream.getAudioTracks().length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('O arquivo não tem áudio ou o navegador não conseguiu capturá-lo')), ms);
    stream.addEventListener('addtrack', () => { if (stream.getAudioTracks().length) { clearTimeout(t); resolve(); } });
  });
}

/** Abre a fonte escolhida e devolve um MediaStream com o áudio */
async function openSource(source, file) {
  const v = el.video;
  if (source === 'tab') {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: false, selfBrowserSurface: 'exclude', systemAudio: 'include',
    });
    if (!s.getAudioTracks().length) {
      s.getTracks().forEach((t) => t.stop());
      throw Object.assign(new Error('A aba foi compartilhada sem áudio'), {
        fix: 'Clique em Iniciar análise de novo e, na janela do navegador, marque “Compartilhar áudio da aba”.',
      });
    }
    v.controls = false; v.muted = true; v.srcObject = s;
    await v.play().catch(() => {});
    el.screen.dataset.mode = 'tab';
    return s;
  }
  if (source === 'file') {
    v.srcObject = null;
    if (v.src) URL.revokeObjectURL(v.src);
    v.src = URL.createObjectURL(file);
    v.muted = false; v.controls = true;
    el.screen.dataset.mode = 'file';
    await v.play();
    const s = (v.captureStream || v.mozCaptureStream).call(v);
    await waitAudioTrack(s);
    return s;
  }
  const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  el.screen.dataset.mode = 'mic';
  return s;
}

// medidor de nível (visibilidade do estado: “está ouvindo?”)
let meter = null;
function startMeter(stream) {
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const an = ctx.createAnalyser(); an.fftSize = 512;
    src.connect(an); // não conecta ao destino: evita eco
    const data = new Float32Array(an.fftSize);
    const loop = () => {
      an.getFloatTimeDomainData(data);
      let sum = 0; for (const x of data) sum += x * x;
      const level = Math.min(1, Math.sqrt(sum / data.length) * 4);
      el.levelBar.style.width = `${(level * 100).toFixed(0)}%`;
      meter.raf = requestAnimationFrame(loop);
    };
    meter = { ctx, raf: requestAnimationFrame(loop) };
  } catch { /* medidor é opcional */ }
}
function stopMeter() {
  if (!meter) return;
  cancelAnimationFrame(meter.raf); meter.ctx.close().catch(() => {}); meter = null;
  el.levelBar.style.width = '0';
}

// ---- motor: reconhecimento do navegador ----
let recognition = null;
function startSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = 'pt-BR';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) addSegment(r[0].transcript);
      else interim += r[0].transcript;
    }
    showInterim(interim, state.manualSpk);
  };
  recognition.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      stop();
      toast('Sem permissão para o microfone', 'Libere o microfone no ícone de cadeado da barra de endereço e tente de novo.', 'error');
    }
  };
  recognition.onend = () => { if (state.running && state.activeEngine === 'browser') { try { recognition.start(); } catch {} } };
  recognition.start();
}

// ---- motor: Deepgram (WebSocket, tempo real) ----
let dg = null;
function startDeepgram(stream) {
  const audio = new MediaStream(stream.getAudioTracks());
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/deepgram?token=${encodeURIComponent(state.token)}`);
  const mime = pickMime();
  const rec = new MediaRecorder(audio, mime ? { mimeType: mime } : undefined);
  dg = { ws, rec };
  rec.ondataavailable = (e) => { if (e.data.size && ws.readyState === WebSocket.OPEN) ws.send(e.data); };
  ws.onopen = () => rec.start(250); // o 1º blob leva o cabeçalho webm
  ws.onmessage = (m) => {
    let d; try { d = JSON.parse(m.data); } catch { return; }
    if (d.type === 'ready') setLive('live', 'Ao vivo');
    if (d.type === 'interim') { if (d.speaker) ensureSpeaker(d.speaker); showInterim(d.text, d.speaker); }
    if (d.type === 'final') {
      showInterim('');
      const now = state.source === 'file' ? el.video.currentTime : null;
      for (const s of d.segments) addSegment(s.text, s.speaker, now != null ? Math.max(0, now - (words(s.text) * 0.38 + 0.8)) : null);
    }
    if (d.type === 'error') toast('Problema na transcrição', d.message, 'error');
  };
  ws.onclose = (e) => {
    if (state.running && state.activeEngine === 'deepgram') {
      stop();
      toast('A transcrição foi encerrada', e.code === 1006 ? 'Confira a chave da Deepgram em Configurações.' : 'Clique em Iniciar análise para retomar.', 'error');
    }
    setTimeout(() => flushPending(), 300);
  };
}
function stopDeepgram() {
  if (!dg) return;
  const { ws, rec } = dg; dg = null;
  if (rec.state === 'recording') rec.stop();
  if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'stop' })); setTimeout(() => ws.close(), 4000); }
  else ws.close();
}

// ---- motores em trechos (Whisper, OpenAI diarize) ----
class ChunkRecorder {
  constructor(stream, onChunk, sliceMs) { Object.assign(this, { stream, onChunk, sliceMs, on: false, mime: pickMime() }); }
  start() { this.on = true; this.#cycle(); }
  stop() { this.on = false; clearTimeout(this.timer); if (this.rec?.state === 'recording') this.rec.stop(); }
  #cycle() { // um MediaRecorder por trecho → cada blob é um arquivo completo
    if (!this.on) return;
    const parts = [];
    const startedAt = state.source === 'file' ? el.video.currentTime : null;
    this.rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    this.rec.onstop = () => {
      if (parts.length) this.onChunk(new Blob(parts, { type: this.rec.mimeType || 'audio/webm' }), startedAt);
      this.#cycle();
    };
    this.rec.start();
    this.timer = setTimeout(() => this.rec.state === 'recording' && this.rec.stop(), this.sliceMs);
  }
}

let chunker = null;
let uploadChain = Promise.resolve();
function sendChunk(blob, engine, startedAt) {
  const manualAtCapture = state.manualSpk; // orador marcado no momento da fala
  uploadChain = uploadChain.then(async () => {
    const form = new FormData();
    form.append('audio', blob, `chunk.${blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
    form.append('provider', engine);
    form.append('session', state.diarizeSession || '');
    form.append('prompt', state.segs.slice(-3).map((s) => s.text).join(' '));
    showInterim('transcrevendo…');
    try {
      const { segments } = await api('/api/transcribe', { form });
      for (const s of segments) {
        const t = startedAt != null ? startedAt + (s.start || 0) : null;
        addSegment(s.text, s.speaker || manualAtCapture, t);
      }
    } catch (err) {
      toast('Um trecho não foi transcrito', `${err.message}. A captura continua.`, 'error');
    } finally { showInterim(''); }
  });
}

// ---------------------------------------------------------------- iniciar / parar
let streams = [];

function setRunning(on, engine = null) {
  state.running = on; state.activeEngine = engine;
  el.btnRun.classList.toggle('danger', on);
  el.btnRun.classList.toggle('primary', !on);
  $('.ico', el.btnRun).textContent = on ? '■' : '▶';
  $('.lbl', el.btnRun).textContent = on ? 'Parar análise' : 'Iniciar análise';
  document.querySelectorAll('input[name="source"]').forEach((r) => { r.disabled = on; });
  $('#btnSettings').disabled = on;
  if (on) setLive(engine === 'deepgram' ? 'connecting' : 'live', engine === 'deepgram' ? 'Conectando' : 'Ao vivo');
  else setLive('idle', 'Parado');
  updateReadiness();
}

async function start(file) {
  const source = state.source;
  const engine = engineFor(source);
  if (!engine) return updateReadiness();
  try {
    if (engine === 'browser') {
      setRunning(true, engine);
      startSpeech();
      openSource('mic').then((s) => { streams.push(s); startMeter(s); }).catch(() => {});
      return;
    }
    const stream = await openSource(source, file);
    streams.push(stream);
    stream.getAudioTracks()[0]?.addEventListener('ended', () => state.running && stop());
    setRunning(true, engine);
    startMeter(stream);
    if (engine === 'deepgram') return startDeepgram(stream);
    if (engine === 'openai-diarize') {
      ({ session: state.diarizeSession } = await api('/api/transcribe/session', { json: { session: state.diarizeSession } }));
    }
    chunker = new ChunkRecorder(new MediaStream(stream.getAudioTracks()), (b, t) => sendChunk(b, engine, t), CHUNK_MS[engine]);
    chunker.start();
  } catch (err) {
    stop();
    if (err.name === 'NotAllowedError') return; // usuário cancelou a escolha — não é erro
    toast('Não foi possível iniciar', err.fix || err.message, 'error', 10000);
  }
}

function stop() {
  const wasChunked = Boolean(chunker);
  if (state.running) setRunning(false);
  try { recognition?.stop(); } catch {}
  recognition = null;
  stopDeepgram();
  chunker?.stop(); chunker = null;
  stopMeter();
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  streams = [];
  showInterim('');
  if (el.screen.dataset.mode === 'file') el.video.pause(); // mantém o vídeo para navegar pela transcrição
  else if (el.screen.dataset.mode !== 'empty') { el.video.srcObject = null; el.screen.dataset.mode = 'stopped'; }
  setTimeout(() => (wasChunked ? uploadChain : Promise.resolve()).then(() => flushPending()), 600);
}

el.btnRun.addEventListener('click', () => {
  if (state.running) return stop();
  if (state.source === 'file') return el.fileInput.click(); // escolhe o arquivo e inicia
  start();
});
el.fileInput.addEventListener('change', () => {
  const f = el.fileInput.files?.[0];
  el.fileInput.value = '';
  if (f) start(f);
});
el.video.addEventListener('ended', () => { if (state.running && state.source === 'file') setTimeout(stop, 1500); });
document.querySelectorAll('input[name="source"]').forEach((r) => r.addEventListener('change', () => {
  state.source = r.value;
  updateReadiness();
}));

el.manual.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = el.manualInput.value.trim();
  if (t.length < 12) { toast('Frase muito curta', 'Escreva a afirmação completa, com pelo menos 12 caracteres.'); return; }
  el.manualInput.value = '';
  state.claimTexts = state.claimTexts.filter((c) => similar(c, t) < 0.8); // permite rechecar
  const eng = state.running ? state.activeEngine : engineFor(state.source);
  const spId = AUTO_ENGINES.has(eng) ? null : state.manualSpk; // no modo automático não há orador “selecionado”
  enqueue(t, { spId, orador: spId ? state.speakers.get(spId)?.name || '' : 'Checagem manual', contexto: contextBefore(300) });
});

$('#btnExport').addEventListener('click', () => {
  if (!state.segs.length && !state.checked.length) { toast('Nada para exportar ainda', 'Inicie uma análise ou cheque uma frase primeiro.'); return; }
  const data = {
    exportado_em: new Date().toISOString(),
    oradores: Object.fromEntries([...state.speakers].map(([id, s]) => [id, s.name])),
    transcricao: state.segs.map((s) => ({ hora: s.ts.toISOString(), tempo_video: s.mediaTime, orador: state.speakers.get(s.speaker)?.name, texto: s.text })),
    checagens: state.checked,
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `checagem-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Exportação baixada', 'Transcrição e checagens salvas em JSON.', 'ok', 4000);
});

// ---------------------------------------------------------------- configurações
const KEY_FIELDS = [
  { id: 'anthropic', label: 'Anthropic', hint: 'Modelo de IA (Claude) e busca na web', ph: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', hint: 'Modelo de IA, busca e transcrição em trechos', ph: 'sk-…' },
  { id: 'google', label: 'Google', hint: 'Modelo de IA alternativo (Gemini)', ph: 'AIza…' },
  { id: 'tavily', label: 'Tavily', hint: 'Busca alternativa', ph: 'tvly-…' },
  { id: 'deepgram', label: 'Deepgram', hint: 'Transcrição em tempo real com oradores', ph: 'cole a chave aqui' },
];
const dlg = $('#settings');
const settingsMsg = $('#settingsMsg');
let removals = new Set();

function renderEngines() {
  const box = $('#engines');
  box.innerHTML = '';
  for (const k of ENGINE_ORDER) {
    const e = ENGINES[k];
    const ok = state.avail[k];
    const why = ok ? '' : k === 'browser' ? 'Este navegador não oferece reconhecimento de fala.' : `Precisa da chave da ${e.key}.`;
    const row = document.createElement('label');
    row.className = 'engine';
    row.innerHTML = `<input type="radio" name="engine" value="${k}" /><div><b></b><span></span>${why ? `<span class="why"> ${esc(why)}</span>` : ''}</div>`;
    $('b', row).textContent = e.name;
    $('span', row).textContent = e.desc;
    const input = $('input', row);
    input.disabled = !ok;
    input.checked = k === state.engine;
    box.appendChild(row);
  }
}

function renderKeyFields(status, editavel) {
  removals = new Set();
  const box = $('#keyFields');
  box.innerHTML = '';
  for (const f of KEY_FIELDS) {
    const s = status[f.id] || {};
    const row = document.createElement('div');
    row.className = 'key-row';
    row.innerHTML = `
      <label for="key-${f.id}"><b></b><span class="key-hint"></span></label>
      <div class="key-input">
        <input type="password" id="key-${f.id}" spellcheck="false" autocomplete="off" />
        <button type="button" class="btn quiet icon" data-act="toggle" aria-label="Mostrar ou ocultar a chave" title="Mostrar/ocultar">👁</button>
        <button type="button" class="btn quiet small" data-act="remove" hidden>Remover</button>
      </div>
      <span class="key-status"></span>`;
    $('b', row).textContent = f.label;
    $('.key-hint', row).textContent = f.hint;
    const input = $('input', row);
    input.placeholder = s.configurada ? `•••• ${s.final} — deixe vazio para manter` : f.ph;
    input.disabled = !editavel;
    const st = $('.key-status', row);
    const base = s.configurada ? `✓ Configurada (${s.origem === 'tela' ? 'salva por esta tela' : 'arquivo .env'})` : 'Não configurada';
    st.textContent = base;
    st.classList.toggle('ok', Boolean(s.configurada));
    const rm = $('[data-act="remove"]', row);
    rm.hidden = !(editavel && s.origem === 'tela');
    rm.addEventListener('click', () => {
      const on = !removals.has(f.id);
      on ? removals.add(f.id) : removals.delete(f.id);
      rm.textContent = on ? 'Desfazer' : 'Remover'; // controle e liberdade: dá para voltar atrás
      st.textContent = on ? 'Será removida ao salvar' : base;
      input.disabled = on;
    });
    $('[data-act="toggle"]', row).addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; });
    box.appendChild(row);
  }
  settingsMsg.textContent = editavel ? '' : 'O cadastro de chaves está bloqueado: abra pelo próprio computador do servidor (localhost) ou defina ACCESS_TOKEN no servidor.';
}

async function openSettings() {
  settingsMsg.textContent = '';
  renderEngines();
  try {
    const data = await readJson(await fetch('/api/settings', { headers: authHeaders() }));
    renderKeyFields(data.keys, data.editavel);
  } catch (e) {
    renderKeyFields({}, false);
    settingsMsg.textContent = e.message === OUTDATED ? OUTDATED : `Não foi possível carregar as chaves: ${e.message}`;
  }
  if (!dlg.open) dlg.showModal();
}

$('#settingsForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const keys = {};
  for (const f of KEY_FIELDS) {
    const input = $(`#key-${f.id}`);
    const v = input.value.trim();
    if (removals.has(f.id)) keys[f.id] = null;
    else if (v) {
      if (/\s/.test(v) || v.length < 8) { settingsMsg.textContent = `A chave da ${f.label} parece incompleta: confira se foi colada inteira, sem espaços.`; input.focus(); return; }
      keys[f.id] = v;
    }
  }
  const btn = $('#btnSaveSettings');
  btn.disabled = true;
  try {
    let alteradas = [];
    if (Object.keys(keys).length) {
      ({ alteradas } = await api('/api/settings', { method: 'PUT', json: { keys } }));
    }
    await refreshHealth();
    const chosen = $('input[name="engine"]:checked')?.value;
    if (chosen && state.avail[chosen]) { state.engine = chosen; store.set('fc_engine', chosen); }
    updateReadiness();
    dlg.close();
    toast('Configurações salvas', alteradas.length ? `Chaves atualizadas: ${alteradas.join(', ')}.` : '', 'ok', 4000);
  } catch (err) {
    settingsMsg.textContent = `Não foi possível salvar: ${err.message}`;
  } finally { btn.disabled = false; }
});
$('#btnSettings').addEventListener('click', openSettings);

$('#btnDiag').addEventListener('click', async () => {
  const btn = $('#btnDiag'), list = $('#diag');
  btn.disabled = true; btn.textContent = 'Testando…';
  list.innerHTML = '';
  try {
    const { resultados } = await api('/api/diagnostico', { json: {} });
    if (!resultados.length) list.innerHTML = '<li class="bad">Nenhum provedor de busca configurado. Cadastre a chave da Anthropic, OpenAI ou Tavily e salve.</li>';
    for (const r of resultados) {
      const li = document.createElement('li');
      li.className = r.ok ? 'good' : 'bad';
      li.innerHTML = `<b></b> <span></span>`;
      $('b', li).textContent = `${r.ok ? '✓' : '✕'} ${r.provedor}`;
      $('span', li).textContent = r.ok
        ? `${r.evidencias} fonte(s) em ${(r.ms / 1000).toFixed(1)} s — ex.: ${hostOf(r.exemplo.url)}`
        : r.erro ? `erro: ${r.erro}` : 'respondeu, mas sem fontes da lista confiável';
      list.appendChild(li);
    }
  } catch (e) {
    list.innerHTML = `<li class="bad">${esc(e.message)}</li>`;
  } finally { btn.disabled = false; btn.textContent = 'Testar busca'; }
});
dlg.addEventListener('close', () => $('#keyFields').querySelectorAll('input').forEach((i) => { i.value = ''; }));

// ---------------------------------------------------------------- ajuda e atalhos
const help = $('#help');
$('#btnHelp').addEventListener('click', () => help.showModal());
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, [contenteditable="true"]') || document.querySelector('dialog[open]')) return;
  if (e.key === '?') { e.preventDefault(); help.showModal(); return; }
  const n = Number(e.key);
  if (n >= 1 && n <= 9 && manualIds()[n - 1]) selectManual(manualIds()[n - 1]);
});

// ---------------------------------------------------------------- início
(async function boot() {
  try {
    const h = await refreshHealth();
    if (h.authRequired && !state.token) askToken();
    if (missingSetup()) openSettings();
  } catch {
    setLive('error', 'Sem servidor');
    el.runHint.textContent = 'Servidor indisponível. Verifique se o npm start está rodando e recarregue a página.';
    el.btnRun.disabled = true;
  }
})();
