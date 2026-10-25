import OpenAI, { toFile } from 'openai';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { config } from '../../config.js';

let client, clientKey, injected = false;
const openai = () => {
  if (injected) return client; // testes
  if (!config.keys.openai) throw new Error('Chave da OpenAI não configurada');
  if (!client || clientKey !== config.keys.openai) {
    clientKey = config.keys.openai;
    client = new OpenAI({ apiKey: clientKey, maxRetries: 1, timeout: 90_000 });
  }
  return client;
};

const HALLUCINATIONS = [
  /legendas? (pela|por) comunidade amara/i, /obrigad[oa] por assistir/i, /inscreva-se no canal/i, /^\W*$/,
];
const isNoise = (t) => HALLUCINATIONS.some((r) => r.test(t));
const extOf = (mime) => (mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : mime.includes('wav') ? 'wav' : 'webm');

/** Transcrição simples (sem oradores) — whisper-1 / gpt-4o-transcribe */
export async function transcribePlain(buffer, mime, prompt = '') {
  const file = await toFile(buffer, `chunk.${extOf(mime)}`, { type: mime });
  const res = await openai().audio.transcriptions.create({
    file, model: config.transcription.whisperModel, language: 'pt', prompt: prompt.slice(-400), response_format: 'json',
  });
  const text = (res.text || '').trim();
  return isNoise(text) ? [] : [{ speaker: null, text }];
}

// ------------------------------------------------------------------
// Diarização em trechos com consistência entre trechos
// ------------------------------------------------------------------
// Cada chamada ao modelo de diarização rotula oradores só dentro daquele trecho ("A", "B"…).
// Para manter o mesmo rótulo ao longo do debate, guardamos por sessão um clipe de 2–10 s de cada
// orador novo e o enviamos como known_speaker_references nas chamadas seguintes (máx. 4 oradores).

const SESSION_TTL = 3 * 60 * 60_000;
const sessions = new Map(); // id → { refs: [{name, dataUrl}], next, touched }

function getSession(id) {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.touched > SESSION_TTL) sessions.delete(k);
  let s = sessions.get(id);
  if (!s) { s = { refs: [], next: 1, touched: now }; sessions.set(id, s); }
  s.touched = now;
  return s;
}

export function resetSession(id) { sessions.delete(id); }

/** Recorta [start, start+dur] do áudio e devolve WAV mono 16 kHz como data URL */
export function cutClip(buffer, start, dur) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg indisponível'));
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-ss', String(start), '-t', String(dur), '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1']);
    const out = []; let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      const buf = Buffer.concat(out);
      if (code !== 0 || buf.length < 1000) return reject(new Error(`ffmpeg falhou: ${err.slice(0, 200)}`));
      resolve(`data:audio/wav;base64,${buf.toString('base64')}`);
    });
    p.stdin.on('error', () => {});
    p.stdin.end(buffer);
  });
}

/**
 * @returns {Promise<Array<{speaker: string, text: string, start: number, end: number}>>}
 */
export async function transcribeDiarized(buffer, mime, sessionId, { cut = cutClip } = {}) {
  const sess = getSession(sessionId || 'default');
  const file = await toFile(buffer, `chunk.${extOf(mime)}`, { type: mime });
  const params = {
    file,
    model: config.transcription.diarizeModel,
    response_format: 'diarized_json',
    chunking_strategy: 'auto',
  };
  if (sess.refs.length) {
    params.known_speaker_names = sess.refs.map((r) => r.name);
    params.known_speaker_references = sess.refs.map((r) => r.dataUrl);
  }
  const res = await openai().audio.transcriptions.create(params);

  const known = new Set(sess.refs.map((r) => r.name));
  const localMap = new Map(); // rótulo local do trecho → nome de sessão
  const out = [];

  for (const seg of res.segments ?? []) {
    const text = (seg.text || '').trim();
    if (!seg.speaker || !text || isNoise(text)) continue;
    let name = seg.speaker;
    if (!known.has(name)) {
      if (!localMap.has(name)) {
        const fresh = `orador_${sess.next++}`;
        localMap.set(name, fresh);
        const dur = Math.min(10, (seg.end ?? 0) - (seg.start ?? 0));
        if (sess.refs.length < 4 && dur >= 2) {
          try {
            sess.refs.push({ name: fresh, dataUrl: await cut(buffer, seg.start, dur) });
            known.add(fresh);
          } catch (e) { console.warn('[diarize] sem clipe de referência:', e.message); }
        }
      }
      name = localMap.get(name);
    }
    out.push({ speaker: name, text, start: seg.start, end: seg.end });
  }
  return out;
}

export const _internals = { sessions, getSession, setClient: (c) => { client = c; injected = true; } };
