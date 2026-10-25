import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Chaves de API cadastradas pela interface.
 * - Persistidas em config.settingsFile (JSON, permissão 0600 em sistemas POSIX).
 * - Têm prioridade sobre o .env; remover pela tela volta a usar o valor do .env, se houver.
 * - Nunca são devolvidas por completo: a API expõe só os 4 últimos caracteres.
 */
export const KEY_NAMES = ['anthropic', 'openai', 'google', 'tavily', 'deepgram'];

const envKeys = { ...config.keys };     // snapshot do .env no boot
let saved = {};                          // chaves vindas da tela
const listeners = new Set();

const filePath = () => path.resolve(config.settingsFile);

function apply() {
  for (const k of KEY_NAMES) config.keys[k] = saved[k] || envKeys[k] || '';
}

export function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    saved = Object.fromEntries(KEY_NAMES.filter((k) => typeof data?.keys?.[k] === 'string' && data.keys[k]).map((k) => [k, data.keys[k]]));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[settings] arquivo ilegível, ignorado:', e.message);
    saved = {};
  }
  apply();
}

function persist() {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ keys: saved, atualizado_em: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Formato mínimo: sem espaços, 8–300 caracteres */
export const validKey = (v) => typeof v === 'string' && /^\S{8,300}$/.test(v);

/**
 * @param {Record<string, string|null>} changes  string = salvar, null ou '' = remover; chave ausente = não altera
 * @returns {string[]} nomes alterados
 */
export function updateKeys(changes = {}) {
  const changed = [];
  for (const k of KEY_NAMES) {
    if (!(k in changes)) continue;
    const v = changes[k] == null ? '' : String(changes[k]).trim();
    if (v && !validKey(v)) throw Object.assign(new Error(`Chave inválida para ${k}`), { status: 400 });
    if ((saved[k] || '') === v) continue;
    if (v) saved[k] = v; else delete saved[k];
    changed.push(k);
  }
  if (changed.length) {
    persist();
    apply();
    for (const fn of listeners) fn(changed);
  }
  return changed;
}

export function keyStatus() {
  return Object.fromEntries(KEY_NAMES.map((k) => {
    const v = config.keys[k];
    return [k, { configurada: Boolean(v), final: v ? v.slice(-4) : '', origem: saved[k] ? 'tela' : envKeys[k] ? 'env' : null }];
  }));
}

export function onKeysChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
