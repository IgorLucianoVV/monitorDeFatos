import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { config, hasKey } from '../config.js';
import { errMsg } from '../lib/util.js';

/** Fábricas por provedor. Para adicionar um provedor (ex.: Ollama, Bedrock), registre aqui. */
const FACTORIES = {
  anthropic: (model) => new ChatAnthropic({ model, apiKey: config.keys.anthropic, maxRetries: 1, maxTokens: 2048 }),
  openai: (model) => new ChatOpenAI({ model, apiKey: config.keys.openai, maxRetries: 1 }),
  google: (model) => new ChatGoogleGenerativeAI({ model, apiKey: config.keys.google, maxRetries: 1 }),
};

export const LLM_PROVIDERS = Object.keys(FACTORIES);

export function parseSpec(spec) {
  const i = spec.indexOf(':');
  if (i < 1) throw new Error(`Spec de modelo inválida: "${spec}" (use provedor:modelo)`);
  return { provider: spec.slice(0, i), model: spec.slice(i + 1) };
}

/** Specs utilizáveis (provedor conhecido e com chave) */
export function usableSpecs(specs) {
  return specs.map(parseSpec).filter((s) => FACTORIES[s.provider] && hasKey(s.provider));
}

/**
 * Cadeia com saída estruturada + fallback entre provedores.
 * invoke() devolve { data, provider, model, falhas } para rastreabilidade.
 * Implementado manualmente (em vez de .withFallbacks) para saber QUAL provedor respondeu.
 */
export function structuredChain(specs, schema, name) {
  const links = usableSpecs(specs).map((s) => ({
    ...s,
    runnable: FACTORIES[s.provider](s.model).withStructuredOutput(schema, { name }),
  }));

  return {
    available: links.length > 0,
    describe: () => links.map((l) => `${l.provider}:${l.model}`),
    async invoke(messages) {
      if (!links.length) throw new Error(`Nenhum provedor de LLM configurado para "${name}" (verifique as chaves)`);
      const falhas = [];
      for (const l of links) {
        try {
          const data = await l.runnable.invoke(messages);
          return { data, provider: l.provider, model: l.model, falhas };
        } catch (e) {
          falhas.push(`${l.provider}:${l.model} → ${errMsg(e)}`);
          console.warn(`[llm:${name}] falhou ${l.provider}:${l.model}:`, errMsg(e));
        }
      }
      throw new Error(`Todos os provedores falharam (${name}): ${falhas.join(' | ')}`);
    },
  };
}
