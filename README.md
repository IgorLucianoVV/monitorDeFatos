# Checagem ao Vivo · v2

Verificador de informações em tempo real para debates. Transcreve a fala **separando os oradores automaticamente**, extrai afirmações factuais checáveis e classifica cada uma como **VERDADEIRO**, **IMPRECISO**, **FALSO** ou **SEM EVIDÊNCIA**, com fontes confiáveis. O pipeline de IA é um conjunto de grafos **LangGraph** com provedores intercambiáveis e fallback.

## Arquitetura

```
 Navegador                                  Servidor (Node/Express + ws)
 ─────────                                  ────────────────────────────
 Microfone / Aba ──► motor de transcrição
   • Deepgram (WS, tempo real)  ──────────► /ws/deepgram ──► proxy ──► Deepgram nova-3 (diarização)
   • OpenAI diarize (trechos 12 s) ───────► /api/transcribe ─► gpt-4o-transcribe-diarize
   • Whisper (trechos, orador manual) ────► /api/transcribe ─► whisper-1
   • Web Speech (orador manual)
        │ segmentos {orador, texto}
        ▼
 buffer por orador ─────────────────────► /api/extract ─► Grafo de extração
                                                            extrair (LLM rápido) → deduplicar
        │ afirmações
        ▼
 fila (3 em paralelo) ──────────────────► /api/check (NDJSON com progresso) ─► Grafo de checagem
```

### Grafo de checagem (`src/graph/check.js`)

```
START → cache ──(hit)────────────────────────────────────────────► END
          └──► planejar ──(Send × N consultas)──► buscar ──► julgar ─┬─(lacuna e rodada < máx)──► planejar
                    └──(sem consultas)─────────────────────► julgar  └──► validar ──► END
```

| Nó | Tipo | Faz |
|---|---|---|
| `cache` | determinístico | afirmação já checada (normalizada) retorna direto |
| `planejar` | LLM rápido | gera até 3 consultas mirando a fonte primária; na 2ª rodada mira a lacuna apontada pelo juiz |
| `buscar` | provedores de busca | **fan-out paralelo via `Send`**, uma execução por consulta; evidências fundidas por URL e numeradas E1, E2… |
| `julgar` | LLM juiz | veredito usando **só** as evidências; cita IDs (não URLs); pode pedir outra rodada |
| `validar` | determinístico | mapeia IDs → fontes reais, descarta IDs inexistentes, rebaixa para SEM_EVIDENCIA se nada sustenta, grava cache |

### Provedores

| Camada | Provedores | Config |
|---|---|---|
| LLM rápido (extração, planejamento) | Anthropic, OpenAI, Google (LangChain) | `LLM_FAST=anthropic:claude-haiku-5-5,openai:gpt-5.5` |
| LLM juiz | idem | `LLM_JUDGE=anthropic:claude-sonnet-5-5,openai:gpt-5.5` |
| Busca | Anthropic web search, OpenAI web search (Responses), Tavily | `SEARCH_PROVIDERS`, `SEARCH_MODE=fallback\|merge` |
| Transcrição | Deepgram (streaming + diarização), OpenAI diarize, Whisper, Web Speech | seletor na interface |

Cada cadeia tenta os provedores na ordem; specs sem chave são ignoradas. O cartão mostra qual modelo julgou e qual provedor trouxe cada evidência. Para adicionar um provedor de LLM, registre a fábrica em `src/providers/llm.js`; para busca, implemente `search(query, { domains, hosts }) → [{url, title, snippet}]` em `src/providers/search/` e registre em `index.js`.

## Interface

O vídeo analisado é o centro da tela. Na **Transmissão**, aparece a aba compartilhada. No **Arquivo**, o vídeo do seu computador é tocado com controles. No **Microfone**, aparece o medidor de nível. Cada veredito surge sobre o vídeo como uma tarja de TV e também entra na lista de checagens.

Princípios aplicados (heurísticas de Nielsen, Leis de UX e WCAG):

| Princípio | Onde está |
|---|---|
| Visibilidade do estado do sistema | indicador Ao vivo / Conectando / Parado, medidor de áudio, etapas de cada checagem (planejar → buscar → avaliar), contador "Checando N afirmações" |
| Correspondência com o mundo real (Lei de Jakob) | tarja de veredito no padrão das checagens de TV; linguagem do usuário ("Transmissão", "Checar frase"), não termos técnicos |
| Controle e liberdade | Parar sempre no mesmo lugar; "Desfazer" ao remover chave; "Checar de novo" em falhas; avisos fecháveis |
| Consistência | o mesmo nome, cor e ícone de cada veredito em tarja, cartão, filtro, ajuda e transcrição |
| Prevenção de erros | Iniciar desabilitado com o motivo e a correção quando falta chave; transcrição incompatível com a fonte é trocada automaticamente |
| Reconhecer em vez de lembrar | atalhos visíveis nos chips (1–9) e na ajuda (?); passo a passo na tela inicial |
| Eficiência | atalhos de teclado; clique na checagem leva ao trecho da fala e, no arquivo, volta o vídeo |
| Design minimalista / divulgação progressiva | escolha de transcrição foi para Configurações; explicação e rastro da checagem ficam recolhidos |
| Mensagens de erro úteis | avisos dizem o que aconteceu e como resolver (ex.: "marque Compartilhar áudio da aba") |
| Lei de Hick / Lei de Fitts | 3 fontes em controle segmentado + 1 botão principal grande, perto da escolha |
| Proximidade e região comum | vídeo e transcrição na mesma coluna; checagens na outra |
| Efeito von Restorff | cartões "Falso" com fundo destacado |
| Acessibilidade (WCAG) | veredito nunca só por cor (ícone + palavra); contraste ≥ 4.5:1 nos textos; foco visível; alvos ≥ 30 px; `aria-live` para novas checagens; tema claro/escuro automático; `prefers-reduced-motion` |

## Garantias de fonte

1. Toda busca é restrita à lista confiável (`allowed_domains` / `filters.allowed_domains` / `include_domains`): órgãos oficiais (`gov.br`, `leg.br`, `jus.br`…), organismos internacionais, checadores IFCN, agências de notícias e periódicos científicos.
2. Depois da busca, `sanitize()` reaplica a lista **com path** (ex.: só `g1.globo.com/fato-ou-fake`) e descarta trechos vazios.
3. O juiz recebe evidências numeradas e só pode citar **IDs**. URL inventada é impossível por construção; ID inexistente é descartado.
4. Sem evidência válida citada → **SEM_EVIDENCIA** (confiança ≤ 30), independente do que o LLM concluiu.

## Separação de oradores

- **Deepgram (recomendado)**: o navegador envia áudio webm/opus por WebSocket ao servidor, que faz proxy para o Deepgram (a chave não sai do servidor). Rótulos são consistentes durante toda a sessão, com latência < 1 s.
- **OpenAI diarize**: trechos de 12 s. Para manter o mesmo rótulo entre trechos, o servidor recorta (ffmpeg) um clipe de 2–10 s de cada orador novo e o envia como `known_speaker_references` nos trechos seguintes (máx. 4 oradores). **Atenção:** a OpenAI anuncia o desligamento de `gpt-4o-transcribe-diarize` em 26/02/2027.
- **Whisper / Web Speech**: sem diarização; use os botões de orador ou as teclas `1`–`9`.

Oradores detectados aparecem como "Orador 1, 2…". Clique no nome para renomear; a transcrição já exibida é atualizada. Dois rótulos com o mesmo nome são tratados como a mesma pessoa nas checagens.

## Rodando

```bash
npm install
npm start               # http://localhost:3000
npm test                # 17 testes: grafo, provedores, proxy WS, chaves e HTTP com fakes
```

## Chaves de API

Cadastre pela própria interface em **⚙ Chaves** (abre sozinho se faltar LLM ou busca). Também dá para usar o `.env` (`cp .env.example .env`).

- As chaves salvas pela tela ficam em `data/settings.json` (fora do git, permissão 0600 em Linux/macOS) e **têm prioridade** sobre o `.env`. Remover pela tela volta a usar o valor do `.env`, se houver.
- Valem na hora: os grafos e clientes de SDK são recriados quando uma chave muda, sem reiniciar.
- A API nunca devolve a chave inteira, só os 4 últimos caracteres.
- Sem `ACCESS_TOKEN`, o cadastro só é aceito a partir da própria máquina (`localhost`). Para cadastrar de outro computador da rede, defina `ACCESS_TOKEN`.
- O arquivo não é criptografado (mesmo nível de proteção do `.env`): proteja o acesso à máquina/servidor.

Node 20+. Chrome ou Edge para captura de áudio de aba. Mínimo funcional: uma chave de LLM + um provedor de busca (ex.: só `ANTHROPIC_API_KEY`) com o motor "Navegador".

## Custos e latência

Por afirmação: 1–2 rodadas × até 3 consultas. Em modo `fallback` cada consulta usa um provedor; em `merge` usa todos. Tempo típico de 10–30 s; o cartão mostra o progresso (consultas, evidências, julgamento). `MAX_SEARCH_ROUNDS=1` e `MAX_QUERIES_PER_ROUND=2` reduzem latência e custo.

## Limitações

- Vereditos são gerados por IA: o painel mostra fontes, trechos e consultas para conferência humana antes de divulgar.
- Dados muito recentes podem ainda não estar nas fontes oficiais → tende a SEM_EVIDENCIA.
- Diarização erra em falas sobrepostas e trocas muito rápidas.
- Cache, rate limit e sessões de diarização são em memória (uma instância).
- Com `ACCESS_TOKEN`, o WebSocket recebe o token na query string; use HTTPS em produção.

## Estrutura

```
src/
  server.js                         rotas HTTP, NDJSON, proxy WS
  config.js                         env, cadeias de provedores, domínios confiáveis
  graph/
    schemas.js                      schemas zod (extração, plano, veredito)
    extract.js                      grafo de extração
    check.js                        grafo de checagem
  providers/
    llm.js                          fábricas LangChain + cadeia com fallback rastreável
    search/{index,anthropic,openai,tavily}.js
    transcription/{deepgram,openai}.js
  lib/util.js
public/                             interface (HTML/CSS/JS puro)
test/                               node:test com provedores falsos
```
