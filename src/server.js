import express from 'express';
import http from 'node:http';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, hasKey } from './config.js';
import { buildExtractGraph } from './graph/extract.js';
import { buildCheckGraph } from './graph/check.js';
import { usableSpecs } from './providers/llm.js';
import { activeSearchProviders, runSearch } from './providers/search/index.js';
import { transcribePlain, transcribeDiarized, resetSession } from './providers/transcription/openai.js';
import { attachDeepgramProxy } from './providers/transcription/deepgram.js';
import { errMsg } from './lib/util.js';
import { loadSettings, updateKeys, keyStatus, onKeysChange, KEY_NAMES } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

export function createApp({ extractGraph, checkGraph } = {}) {
  const app = express();
  let eg = extractGraph, cg = checkGraph;
  const getExtract = () => (eg ??= buildExtractGraph());
  const getCheck = () => (cg ??= buildCheckGraph());
  // as cadeias LangChain capturam as chaves ao serem criadas: recria os grafos quando mudam
  onKeysChange(() => { if (!extractGraph) eg = null; if (!checkGraph) cg = null; });

  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        mediaSrc: ["'self'", 'blob:'],
      },
    },
  }));
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

  app.use('/api', (req, res, next) => {
    if (!config.accessToken || req.path === '/health') return next();
    if (req.get('x-access-token') === config.accessToken) return next();
    return res.status(401).json({ error: 'Token de acesso inválido' });
  });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false }));

  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
    console.error(`[${req.method} ${req.path}]`, errMsg(err));
    if (res.headersSent) return res.end();
    res.status(err?.status >= 400 && err.status < 500 ? err.status : 502).json({ error: errMsg(err) });
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      authRequired: Boolean(config.accessToken),
      llm: {
        fast: usableSpecs(config.llm.fast).map((s) => `${s.provider}:${s.model}`),
        judge: usableSpecs(config.llm.judge).map((s) => `${s.provider}:${s.model}`),
      },
      search: { providers: activeSearchProviders(), mode: config.search.mode },
      transcription: {
        deepgram: hasKey('deepgram'),       // streaming com oradores
        openaiDiarize: hasKey('openai'),    // trechos com oradores
        whisper: hasKey('openai'),          // trechos sem oradores
      },
      trustedDomains: config.trustedDomains,
    });
  });

  // ---------- chaves de API cadastradas pela tela ----------
  // Sem ACCESS_TOKEN, só aceita alterações vindas da própria máquina (localhost).
  const canEditSettings = (req) => Boolean(config.accessToken) || isLoopback(req);

  app.get('/api/settings', (req, res) => {
    res.json({ keys: keyStatus(), editavel: canEditSettings(req) });
  });

  app.put('/api/settings', wrap(async (req, res) => {
    if (!canEditSettings(req)) {
      return res.status(403).json({ error: 'Defina ACCESS_TOKEN no servidor para cadastrar chaves a partir de outra máquina' });
    }
    const input = req.body?.keys;
    if (!input || typeof input !== 'object') return res.status(400).json({ error: 'Corpo inválido' });
    const changes = Object.fromEntries(Object.entries(input).filter(([k]) => KEY_NAMES.includes(k)));
    const alteradas = updateKeys(changes);
    if (alteradas.length) console.log(`[settings] chaves atualizadas pela tela: ${alteradas.join(', ')}`);
    res.json({ alteradas, keys: keyStatus() });
  }));

  /** Testa cada provedor de busca isoladamente com uma consulta conhecida */
  app.post('/api/diagnostico', wrap(async (req, res) => {
    const consulta = str(req.body?.consulta, 200) || 'IBGE taxa de desocupação PNAD Contínua';
    const provedores = activeSearchProviders();
    const resultados = await Promise.all(provedores.map(async (p) => {
      const t0 = Date.now();
      const { evidence, trace } = await runSearch(consulta, { providers: [p], mode: 'fallback' });
      const erro = trace.find((t) => t.includes(' erro — '))?.split(' erro — ')[1] || '';
      return { provedor: p, ok: evidence.length > 0, evidencias: evidence.length, erro, ms: Date.now() - t0, exemplo: evidence[0] ? { url: evidence[0].url, trecho: evidence[0].snippet.slice(0, 200) } : null };
    }));
    res.json({ consulta, resultados });
  }));

  app.post('/api/extract', wrap(async (req, res) => {
    const novo = str(req.body?.novo, 4000);
    if (novo.split(/\s+/).length < 5) return res.json({ afirmacoes: [] });
    const out = await getExtract().invoke({
      novo,
      contexto: str(req.body?.contexto, 3000),
      orador: str(req.body?.orador, 80),
      jaChecadas: (Array.isArray(req.body?.jaChecadas) ? req.body.jaChecadas : []).slice(-30).map((s) => str(s, 300)).filter(Boolean),
    });
    res.json({ afirmacoes: out.afirmacoes, provedor: out.provedor });
  }));

  /** Checagem com progresso em NDJSON: {type:'etapa'} … {type:'resultado'} */
  app.post('/api/check', wrap(async (req, res) => {
    const afirmacao = str(req.body?.texto, 600);
    if (afirmacao.length < 12) return res.status(400).json({ error: 'Afirmação muito curta' });

    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('x-accel-buffering', 'no');
    const emit = (o) => res.write(JSON.stringify(o) + '\n');

    let resultado = null;
    try {
      const stream = await getCheck().stream(
        { afirmacao, orador: str(req.body?.orador, 80), contexto: str(req.body?.contexto, 1500) },
        { streamMode: 'updates', recursionLimit: 40 },
      );
      for await (const chunk of stream) {
        for (const [no, up] of Object.entries(chunk)) {
          if (!up) continue;
          if (up.resultado) resultado = up.resultado;
          if (no === 'planejar') emit({ type: 'etapa', etapa: 'planejar', consultas: up.consultas, rodada: up.rodada });
          if (no === 'buscar') emit({ type: 'etapa', etapa: 'buscar', consulta: up.consultasFeitas?.[0], evidencias: up.evidencias?.length ?? 0 });
          if (no === 'julgar') emit({ type: 'etapa', etapa: 'julgar', preliminar: up.juizo?.veredito, maisBusca: Boolean(up.juizo?.precisa_mais_busca) });
        }
      }
      if (!resultado) throw new Error('Grafo terminou sem resultado');
      emit({ type: 'resultado', data: resultado });
    } catch (e) {
      console.error('[check]', errMsg(e));
      emit({ type: 'erro', error: errMsg(e) });
    }
    res.end();
  }));

  app.post('/api/transcribe', upload.single('audio'), wrap(async (req, res) => {
    if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Áudio ausente' });
    if (req.file.size < 2000) return res.json({ segments: [] });
    const mime = req.file.mimetype || 'audio/webm';
    const provider = str(req.body?.provider, 30) || 'whisper';
    const segments = provider === 'openai-diarize'
      ? (await transcribeDiarized(req.file.buffer, mime, str(req.body?.session, 64))).map((s) => ({ ...s, speaker: `oa:${s.speaker}` }))
      : await transcribePlain(req.file.buffer, mime, str(req.body?.prompt, 600));
    res.json({ segments });
  }));

  app.post('/api/transcribe/session', (req, res) => {
    const old = str(req.body?.session, 64);
    if (old) resetSession(old);
    res.json({ session: randomUUID() });
  });

  return app;
}

export function startServer(port = config.port) {
  loadSettings();
  const server = http.createServer(createApp());
  attachDeepgramProxy(server, { authorize: (t) => !config.accessToken || t === config.accessToken });
  return new Promise((resolve) => server.listen(port, () => {
    console.log(`Verificador ao vivo em http://localhost:${port}`);
    console.log(`  LLM rápido: ${usableSpecs(config.llm.fast).map((s) => s.provider + ':' + s.model).join(' → ') || 'NENHUM'}`);
    console.log(`  LLM juiz:   ${usableSpecs(config.llm.judge).map((s) => s.provider + ':' + s.model).join(' → ') || 'NENHUM'}`);
    console.log(`  Busca:      ${activeSearchProviders().join(' → ') || 'NENHUM'} (${config.search.mode})`);
    console.log(`  Transcrição: deepgram=${hasKey('deepgram')} openai=${hasKey('openai')}`);
    resolve(server);
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) startServer();
