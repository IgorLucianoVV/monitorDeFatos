import WebSocket, { WebSocketServer } from 'ws';
import { config } from '../../config.js';

/** Agrupa palavras consecutivas do mesmo orador em segmentos */
export function groupBySpeaker(words = []) {
  const segs = [];
  for (const w of words) {
    const sp = w.speaker ?? 0;
    const token = w.punctuated_word || w.word || '';
    const last = segs.at(-1);
    if (last && last.speaker === sp) last.text += ' ' + token;
    else segs.push({ speaker: sp, text: token });
  }
  return segs.map((s) => ({ speaker: `dg:${s.speaker}`, text: s.text.trim() })).filter((s) => s.text);
}

export function deepgramUrl() {
  const t = config.transcription;
  const q = new URLSearchParams({
    model: t.deepgramModel,
    language: t.deepgramLanguage,
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    endpointing: '300',
  });
  const [k, v] = t.deepgramDiarizeParam.split('=');
  if (k) q.set(k, v ?? 'true');
  return `wss://api.deepgram.com/v1/listen?${q}`;
}

/**
 * Proxy WebSocket navegador ⇄ Deepgram (a chave nunca vai ao navegador).
 * Cliente envia áudio binário (webm/opus do MediaRecorder); recebe JSON:
 *   { type:'ready' } | { type:'interim', text, speaker } | { type:'final', segments:[{speaker,text}] } | { type:'error', message }
 */
export function attachDeepgramProxy(server, { path = '/ws/deepgram', authorize = () => true, connect } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  const openUpstream = connect ?? (() => new WebSocket(deepgramUrl(), { headers: { Authorization: `Token ${config.keys.deepgram}` } }));

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== path) return;
    if (!config.keys.deepgram || !authorize(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, (client) => bridge(client, openUpstream()));
  });
  return wss;
}

function bridge(client, upstream) {
  const pending = [];
  let lastAudio = Date.now();
  const send = (o) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(o));

  const keepAlive = setInterval(() => {
    if (upstream.readyState === WebSocket.OPEN && Date.now() - lastAudio > 5000) {
      upstream.send(JSON.stringify({ type: 'KeepAlive' }));
    }
  }, 4000);

  upstream.on('open', () => {
    for (const c of pending.splice(0)) upstream.send(c);
    send({ type: 'ready' });
  });

  upstream.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type !== 'Results') return;
    const alt = m.channel?.alternatives?.[0];
    if (!alt?.transcript?.trim()) return;
    if (m.is_final) send({ type: 'final', segments: groupBySpeaker(alt.words) });
    else send({ type: 'interim', text: alt.transcript, speaker: alt.words?.[0] ? `dg:${alt.words[0].speaker ?? 0}` : null });
  });

  upstream.on('error', (e) => send({ type: 'error', message: `Deepgram: ${e.message}` }));
  upstream.on('unexpected-response', (_req, res) => send({ type: 'error', message: `Deepgram recusou a conexão (HTTP ${res.statusCode})` }));
  upstream.on('close', () => { clearInterval(keepAlive); if (client.readyState === WebSocket.OPEN) client.close(); });

  client.on('message', (data, isBinary) => {
    if (!isBinary) {
      // {type:'stop'} → pede ao Deepgram para finalizar; os últimos resultados ainda chegam ao cliente
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'stop' && upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: 'CloseStream' }));
      return;
    }
    lastAudio = Date.now();
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
    else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 200) pending.push(data);
  });

  client.on('close', () => {
    clearInterval(keepAlive);
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({ type: 'CloseStream' }));
      setTimeout(() => upstream.close(), 1500);
    } else upstream.terminate?.();
  });
}
