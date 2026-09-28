# Spec — Agente de IA conversacional, harness de teste E2E e observabilidade

Data: 2026-07-04
Status: aprovado em conversa (design review seção a seção)

## 1. Contexto e diagnóstico

O sistema é um CRM de prospecção B2B: extração de leads do Google Maps (SerpAPI),
enriquecimento com fotos + classificação visual, pipeline kanban, automação de
outreach por WhatsApp (Evolution API) com editor visual de fluxos e fila de envio
com horário comercial. Produção ativa, com dados reais.

Achados que motivam este trabalho:

1. O bloco `ai_agent` do editor de fluxos é fachada: o painel de configuração
   (`src/components/flows/ConfigPanel.tsx`) oferece modelo, prompt, regras,
   temperatura e histórico, mas o switch de execução em
   `supabase/functions/execute-flow/index.ts` não possui case `ai_agent` — o
   bloco é ignorado silenciosamente.
2. Provider inconsistente: o UI lista modelos no formato OpenRouter
   (`google/gemini-3-flash-preview`, `openai/gpt-5-mini` — nomes fictícios),
   enquanto o backend chama a API da OpenAI diretamente com `gpt-4o-mini` fixo
   (`whatsapp-webhook`, `enrich-lead`).
3. Chamadas de IA sem nenhum registro de tokens, custo, latência ou erro.
   Falhas são engolidas por `catch` silencioso.
4. Zero infraestrutura de teste: sem runner, sem script `test`, nenhum arquivo
   de teste no repositório.
5. Lógica de roteamento de blocos (`findNextBlockId`,
   `resolveExistingNextBlockId`) duplicada entre `execute-flow` e
   `whatsapp-webhook`, com versões já divergentes.
6. `pg_cron`/`pg_net` habilitados mas nenhum `cron.schedule` versionado nas
   migrations — agendamento de `process-flows`/`process-queue` não é
   reproduzível a partir do repositório.
7. O trigger SQL `auto_trigger_flow_on_stage` tem URL e anon key do projeto de
   produção hardcoded — inviabiliza qualquer segundo ambiente.
8. UI com hex hardcoded inline espalhado, três editores de fluxo coexistindo e
   página de logs que trunca detalhes.

## 2. Decisões de escopo (aprovadas)

| Tema                        | Decisão                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Ordem de ataque             | Fase A mínima (harness) → Fases B+C juntas (motor + observabilidade) → Fase D (UI/UX)                                     |
| Comportamento do `ai_agent` | Conversa até objetivo: SDR virtual multi-turno com saídas Objetivo / Desistiu / Limite                                    |
| Provider LLM                | OpenRouter unificado (agente, classificador de etapa, vision do enrich)                                                   |
| Ambiente E2E                | Projeto Supabase de staging na nuvem + mocks por variável de ambiente                                                     |
| Observabilidade             | IA completa + custos SerpAPI + saúde de envios WhatsApp, em página própria no app                                         |
| Motor alvo do agente        | Canvas visual (`FlowEditor` + `execute-flow`); `execute-sequence` fica fora                                               |
| Profundidade UI/UX          | Consolidar + polir com padrão visual alto; sem redesign de identidade                                                     |
| Arquitetura do motor        | Agent mode no `flow_executions.context` + extração de `_shared/flow-routing.ts` e `_shared/ai.ts`; sem reescrita do motor |

Fora de escopo (cortado deliberadamente): RAG/ferramentas no agente, A/B de
prompts, billing por cliente, aposentadoria dos editores extras, CI/CD, i18n,
multi-provider simultâneo.

## 3. Fase A mínima — Harness de teste

### 3.1 Testes de unidade (Vitest)

- Instalar Vitest + script `test`. Sem jsdom nesta fase; alvo é lógica pura.
- Cobertura obrigatória ≥ 80% (lines, branches, functions, statements),
  enforçada por `coverage.thresholds` no config — suite FALHA abaixo disso.
  Escopo da métrica: código de domínio (`supabase/functions/_shared/**`,
  `src/lib/**`, `src/hooks/**`, `src/services/**`, `src/utils/**`).
  Excluídos da métrica: vendor shadcn (`src/components/ui/**`), arquivos
  gerados (`*.gen.ts`) e wrappers declarativos de rota (`src/routes/**`) —
  páginas e jornadas são cobertas pelo E2E Playwright, não pela métrica de
  unidade.
- Extrair para módulos TypeScript puros (sem APIs Deno, sem imports por URL),
  importáveis tanto pelas edge functions quanto pelo Vitest:
  - `supabase/functions/_shared/flow-routing.ts` — fonte única de
    `findNextBlockId` / `resolveExistingNextBlockId` / `findFallbackBlockId`.
    `execute-flow` e `whatsapp-webhook` passam a importar daqui (fim da
    duplicação divergente).
  - `supabase/functions/_shared/agent-prompt.ts` — montagem do prompt do agente
    (config do bloco + histórico + dados do lead + guardrails) e parse da
    resposta estruturada.
  - Cálculo/normalização de custo e helpers de observabilidade.
- TDD: cada módulo extraído nasce com teste vermelho antes da implementação.

### 3.2 Staging

- Novo projeto Supabase dedicado a testes. Migrations aplicadas via CLI
  (`supabase link` + `supabase db push`).
- Nova migration parametriza o trigger `auto_trigger_flow_on_stage`: URL do
  projeto e chave saem do hardcode e passam a ser lidas de `global_settings`
  (tabela existente), preenchidas por ambiente.
- Secrets de staging: `OPENROUTER_API_KEY` real, `EVOLUTION_MOCK=true`.
- `EVOLUTION_MOCK=true` faz `process-queue` e `whatsapp-proxy` pularem a
  chamada HTTP à Evolution API e reportarem sucesso simulado, com log
  identificando o mock. Produção nunca define essa variável.

### 3.3 E2E (Playwright)

- Playwright instalado com script `test:e2e`, apontando para o dev server local
  conectado ao staging.
- Mensagens inbound do lead são simuladas com POST direto ao
  `whatsapp-webhook` usando payload no formato Evolution (mesma forma que a API
  real entrega).
- Jornada coberta (crítica): login → criar lead → criar fluxo no canvas com
  bloco `ai_agent` → disparar → mensagem na fila → simular resposta do lead →
  agente responde → decisão de saída → custo e transcript visíveis na página de
  observabilidade.

## 4. Fase B — Motor do agente conversacional

### 4.1 Estado

- `flow_executions.context.agent = { block_id, turns, status, started_at }`
  com `status ∈ { active, goal, giveup, limit }`. Sem tabela nova de sessão.
- `leads.flow_waiting_reply = true` enquanto o agente aguarda o lead.

### 4.2 Ciclo

1. **Entrada** — `execute-flow` ganha case `ai_agent`: monta o contexto, gera a
   primeira mensagem do agente via LLM, enfileira em `send_queue`, grava
   `context.agent` com `turns = 1`, marca execução `waiting_response` e pausa.
2. **Turno** — `whatsapp-webhook`, ao receber inbound de lead com execução em
   modo agente (`context.agent.status === 'active'`), delega à nova edge
   function `ai-agent-reply` (mesmo padrão do branch `mode === 'sequence'` já
   existente).
3. **`ai-agent-reply`** — carrega config do bloco, histórico de `messages`
   (limite 30) e dados do lead; chama OpenRouter exigindo JSON estruturado:
   `{ "reply": string, "decision": "continue" | "goal" | "giveup", "reason": string }`.
   - `continue`: enfileira `reply` em `send_queue`, incrementa `turns`, segue
     aguardando. Se `turns >= max_turns`, força `decision = limit`.
   - `goal` / `giveup` / `limit`: envia a última `reply` (quando houver), limpa
     o modo agente e delega a `execute-flow` para continuar o fluxo pela edge
     do handle correspondente.
4. **Saídas no canvas** — o bloco `ai_agent` passa a ter três handles nomeados:
   `goal` (Objetivo), `giveup` (Desistiu), `limit` (Limite). O roteamento usa
   `_shared/flow-routing.ts` com aliases desses handles.

### 4.3 Configuração do bloco

- Campos existentes mantidos: prompt, regras, temperatura, máx. caracteres,
  usar histórico.
- Novos: `max_turns` (default 8), `goal_description` (o que caracteriza
  objetivo atingido — entra no prompt e na decisão).
- Lista de modelos do UI substituída por modelos reais do OpenRouter, validados
  contra o endpoint `/models` durante a implementação (não confiar em
  conhecimento de treino). Defaults: modelo econômico para classificação,
  modelo intermediário para o agente.

### 4.4 Migração das chamadas existentes

- Classificador de etapa do `whatsapp-webhook` e vision do `enrich-lead`
  passam a usar `_shared/ai.ts` → OpenRouter (modelo econômico configurável).
  Comportamento funcional preservado; ganham registro em `api_calls` e retry.

### 4.5 Concorrência e idempotência

- Dedupe de inbound por `whatsapp_id` (já existe) permanece a primeira barreira.
- Lock otimista no turno do agente: update condicional do `context.agent`
  (marca de processamento) garante que duas invocações simultâneas do webhook
  não gerem duas respostas para a mesma mensagem.
- Limite duro de turnos (`max_turns`) e `maxSteps` do motor preservados contra
  loops.

### 4.6 Guardrails do agente

- Prompt de sistema fixo, sempre presente: não inventar preços/prazos/fatos
  fora do fornecido; respeitar as `rules` do bloco; responder no idioma do
  lead (default pt-BR); limite de caracteres; nunca revelar que há um fluxo
  automatizado a não ser que instruído.
- Resposta fora do JSON esperado → 1 retry; persistindo, loga erro em
  `api_calls`, não envia nada e mantém o modo agente aguardando (fail-safe:
  silêncio em vez de mensagem quebrada).

## 5. Fase C — Observabilidade

### 5.1 Tabela `api_calls`

Colunas: `id`, `user_id`, `lead_id`, `flow_id`, `execution_id`, `block_id`,
`provider` (`openrouter` | `serpapi` | `evolution`), `feature`
(`agent_reply` | `agent_opening` | `stage_classifier` | `photo_vision` |
`extract_search` | `enrich_details` | `enrich_photos` | `enrich_reviews` |
`instagram_profile`; enum aberto — novas features exigem novo valor
documentado), `model`, `status` (`ok` | `error`),
`error_message`, `latency_ms`, `prompt_tokens`, `completion_tokens`,
`cost_usd_micros` (bigint — microdólares, inteiro; dinheiro nunca em float e
centavos não têm precisão para LLM), `request` jsonb, `response` jsonb,
`created_at`. Índices por `(user_id, created_at)`, `feature`, `lead_id`.
RLS: usuário lê apenas as próprias linhas; escrita só via service role.

- Custo OpenRouter: real, retornado pela API com `usage: { include: true }`.
- Custo SerpAPI: derivado (custo por busca configurável em `global_settings`),
  registrado por unidade de busca.
- Payloads `request`/`response` limitados: sem imagens/base64, truncamento
  defensivo de campos longos.

### 5.2 Instrumentação

- `_shared/ai.ts` expõe `callLLM({ feature, model, messages, contexto })`:
  chama OpenRouter, mede latência, grava `api_calls` SEMPRE (sucesso e erro),
  retry 1x em 429/5xx. Toda chamada LLM do sistema passa por aqui.
- `_shared/serp.ts` expõe `serpFetch(feature, url, contexto)` com o mesmo
  contrato de registro.
- Envios WhatsApp: sem instrumentação nova — views SQL agregam
  `send_queue`/`messages` existentes (enviadas, falhas, pendentes, tempo em
  fila).

### 5.3 Página `/observabilidade`

- Cards de resumo: gasto de IA hoje/7d/30d, nº de chamadas, taxa de erro,
  latência p50/p95; buscas SerpAPI por feature; WhatsApp enviadas/falhas/fila.
- Gráfico de gasto por dia (14 dias) empilhado por feature.
- Feed de conversas do agente: transcript por lead com custo por turno e
  decisão final.
- Tabela de chamadas com drill-down (request/response formatados).
- Agregações via views SQL (não agregar no cliente).
- Exibição de custo em USD (moeda dos providers), convertendo de
  `cost_usd_micros` apenas na camada de exibição.

## 6. Fase D — UI/UX (consolidar + polir)

- Abertura da fase: auditoria visual com o app rodando (screenshots página a
  página) para inventário fino; este spec fixa o rumo, não a lista final.
- Design tokens: eliminar hex inline (`#111118`, `#2a2a3a`, ...) substituindo
  por tokens do tema; mapa de conversão único aplicado em todas as páginas.
- Padrão visual alto e intencional: hierarquia tipográfica, espaçamento e
  estados (loading / vazio / erro) consistentes e desenhados — nada de
  defaults genéricos. Gráficos da página de observabilidade seguem o mesmo
  sistema visual.
- Canvas é o editor principal na navegação; os outros dois saem do caminho
  primário (sem remoção nesta fase).
- Bloco `ai_agent` no canvas exibe as três saídas nomeadas.
- Logs: detalhes expansíveis (fim do truncate), filtros mantidos.
- Navegação inclui a página Observabilidade.

## 7. Segurança e configuração

- `OPENROUTER_API_KEY` nos secrets de produção e staging. `EVOLUTION_MOCK`
  apenas em staging.
- Chaves nunca no repositório; `.env` permanece ignorado pelo git.
- Trigger de estágio parametrizado (fim do hardcode de URL/anon key em SQL).
- RLS em `api_calls` desde a criação.

## 8. Critérios de sucesso

E2E verde no staging cobrindo:

1. Lead responde → agente responde → `api_calls` registra tokens, latência e
   `cost_usd_micros > 0`.
2. Conversa atinge objetivo → fluxo segue pela saída Objetivo → bloco seguinte
   executa (ex.: `move_pipeline`).
3. Limite de turnos atingido → saída Limite.
4. Página de observabilidade mostra gasto agregado, transcript e falhas.
5. `lint`, typecheck e `build` verdes; unit tests verdes com cobertura
   ≥ 80% no escopo definido em §3.1 (gate automático do runner).

Nada é declarado pronto sem essas evidências executadas e mostradas.

## 9. Riscos e mitigação

- **Produção viva**: mudanças em `whatsapp-webhook`/`execute-flow` atrás de
  caminhos aditivos (modo agente só ativa em execuções novas com bloco
  `ai_agent`); migrations aditivas; validação completa em staging antes de
  aplicar em produção.
- **Cron não versionado**: verificar jobs existentes no projeto de produção
  antes da fase B; versionar `cron.schedule` em migration.
- **Nomes de modelo**: validados contra a API do OpenRouter na implementação.
- **Custo de teste**: E2E usa modelo econômico; smoke com chamada real é
  explícito e raro.
