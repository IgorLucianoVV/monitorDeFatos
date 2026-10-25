import 'dotenv/config';

/**
 * Fontes permitidas. Critério: órgãos oficiais e estatísticos, judiciário/legislativo,
 * organismos internacionais, checadores signatários do IFCN, agências de notícias
 * e periódicos científicos revisados por pares.
 * Entradas com path (ex.: g1.globo.com/fato-ou-fake) são aplicadas com path na validação;
 * provedores de busca que só aceitam host recebem só o host e o path é imposto depois.
 */
export const DEFAULT_TRUSTED_DOMAINS = [
  'gov.br', 'leg.br', 'jus.br', 'mp.br', 'fgv.br', 'fiocruz.br',
  'lupa.uol.com.br', 'aosfatos.org', 'projetocomprova.com.br',
  'g1.globo.com/fato-ou-fake', 'estadao.com.br/estadao-verifica',
  'agenciabrasil.ebc.com.br', 'reuters.com', 'apnews.com', 'afp.com',
  'who.int', 'paho.org', 'worldbank.org', 'imf.org', 'oecd.org', 'un.org',
  'cepal.org', 'ilo.org', 'ourworldindata.org',
  'scielo.br', 'nature.com', 'thelancet.com', 'nejm.org', 'ncbi.nlm.nih.gov',
];

const csv = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 3000),
  accessToken: process.env.ACCESS_TOKEN || '',

  // Valores efetivos: chave salva pela tela (settings.json) > .env. Ver src/settings.js
  keys: {
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    openai: process.env.OPENAI_API_KEY || '',
    google: process.env.GOOGLE_API_KEY || '',
    tavily: process.env.TAVILY_API_KEY || '',
    deepgram: process.env.DEEPGRAM_API_KEY || '',
  },
  settingsFile: process.env.SETTINGS_FILE || 'data/settings.json',

  // Cadeias "provedor:modelo" — o 1º é o primário, os demais são fallback.
  // Entradas cujo provedor não tem chave são ignoradas.
  llm: {
    fast: csv(process.env.LLM_FAST || 'anthropic:claude-haiku-5-5,openai:gpt-5.5'),
    judge: csv(process.env.LLM_JUDGE || 'anthropic:claude-sonnet-5-5,openai:gpt-5.5'),
  },

  search: {
    providers: csv(process.env.SEARCH_PROVIDERS || 'anthropic,openai,tavily'),
    mode: process.env.SEARCH_MODE === 'merge' ? 'merge' : 'fallback',
    anthropicModel: process.env.SEARCH_ANTHROPIC_MODEL || 'claude-haiku-5-5',
    anthropicTool: process.env.SEARCH_ANTHROPIC_TOOL || 'web_search_20250305',
    openaiModel: process.env.SEARCH_OPENAI_MODEL || 'gpt-5.5',
    maxQueries: num(process.env.MAX_QUERIES_PER_ROUND, 3),
    maxRounds: num(process.env.MAX_SEARCH_ROUNDS, 2),
    maxEvidence: num(process.env.MAX_EVIDENCE, 12),
  },

  transcription: {
    whisperModel: process.env.TRANSCRIBE_MODEL || 'whisper-1',
    diarizeModel: process.env.DIARIZE_MODEL || 'gpt-4o-transcribe-diarize',
    deepgramModel: process.env.DEEPGRAM_MODEL || 'nova-3',
    deepgramLanguage: process.env.DEEPGRAM_LANGUAGE || 'pt-BR',
    // diarize_model=latest é o parâmetro atual; troque para diarize=true se sua conta usar o legado
    deepgramDiarizeParam: process.env.DEEPGRAM_DIARIZE_PARAM || 'diarize_model=latest',
  },

  trustedDomains: csv(process.env.TRUSTED_DOMAINS).length ? csv(process.env.TRUSTED_DOMAINS) : DEFAULT_TRUSTED_DOMAINS,
  cacheTtlMs: num(process.env.CACHE_TTL_MIN, 360) * 60_000,
};

/**
 * Sufixos públicos (gov.br, leg.br…) podem não ser aceitos como "domínio" por alguns provedores de busca.
 * Por isso, além do sufixo, enviamos explicitamente os órgãos mais usados em checagens.
 * A validação final (isTrustedUrl) continua aceitando QUALQUER subdomínio do sufixo.
 */
const SUFFIX_HOSTS = {
  'gov.br': ['planalto.gov.br', 'ibge.gov.br', 'agenciadenoticias.ibge.gov.br', 'bcb.gov.br', 'ipea.gov.br',
    'tesourotransparente.gov.br', 'receita.fazenda.gov.br', 'portaldatransparencia.gov.br', 'saude.gov.br',
    'datasus.saude.gov.br', 'inep.gov.br', 'mec.gov.br', 'mj.gov.br', 'pf.gov.br', 'bndes.gov.br',
    'tcu.gov.br', 'cgu.gov.br', 'in.gov.br', 'agenciagov.ebc.com.br'],
  'leg.br': ['camara.leg.br', 'senado.leg.br', 'congressonacional.leg.br'],
  'jus.br': ['stf.jus.br', 'stj.jus.br', 'tse.jus.br', 'cnj.jus.br', 'tst.jus.br'],
  'mp.br': ['mpf.mp.br'],
};

/** Hosts para APIs que não aceitam path, sem duplicatas (só os que passam em isTrustedUrl) */
export const trustedHosts = (domains = config.trustedDomains) => {
  const base = domains.map((d) => d.split('/')[0].toLowerCase());
  const extra = base.flatMap((h) => SUFFIX_HOSTS[h] || []).filter((h) => isTrustedUrl(`https://${h}/`, domains));
  return [...new Set([...base, ...extra])];
};

/** true se a URL pertence a um domínio (ou domínio+path) da lista confiável */
export function isTrustedUrl(url, domains = config.trustedDomains) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const path = u.pathname.toLowerCase();
  return domains.some((d) => {
    const [dHost, ...rest] = d.toLowerCase().split('/');
    if (!(host === dHost || host.endsWith('.' + dHost))) return false;
    return !rest.length || path.startsWith('/' + rest.join('/'));
  });
}

export const hasKey = (provider) => Boolean(config.keys[provider]);
