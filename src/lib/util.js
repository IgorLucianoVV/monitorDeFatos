export function todayPtBR() {
  return new Date().toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'long', year: 'numeric',
  });
}

export const normalizeText = (s = '') =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9% ]/g, ' ').replace(/\s+/g, ' ').trim();

export const normUrl = (u) => {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/$/, '').toLowerCase();
  } catch { return ''; }
};

/** Cache em memória com TTL (uma instância; troque por Redis para escalar) */
export class TtlCache {
  constructor(ttlMs, max = 500) { this.ttl = ttlMs; this.max = max; this.map = new Map(); }
  get(k) {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (Date.now() > e.exp) { this.map.delete(k); return undefined; }
    return e.v;
  }
  set(k, v) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(k, { v, exp: Date.now() + this.ttl });
  }
  clear() { this.map.clear(); }
}

export const errMsg = (e) => e?.error?.message || e?.message || String(e);
