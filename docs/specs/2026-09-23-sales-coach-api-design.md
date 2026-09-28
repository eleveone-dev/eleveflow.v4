# Spec — API de leitura para o Eleve Sales Coach

Data: 2026-09-23
Status: decisões do dono tomadas em 2026-09-23 e 2026-09-24 (fim do documento). Não implementado.
Escopo: repositório `eleve.flow2`, projeto Supabase `xlycuunqpgpyfmafgajr` (produção).

## Contexto

O Eleve Office roda em outra VPS e vai ganhar um avatar, o Eleve Sales Coach, que
analisa o comercial da Eleve One e sugere próximas ações: follow-ups atrasados,
leads parados, conversão do funil e motivos de perda.

Ele precisa ler esses dados do Eleve Flow. A primeira versão **só lê**: não cria
tarefa, não move lead, não manda mensagem. Escrita fica para uma v2, com aprovação
e histórico.

A Eleve One tem um vendedor só, que usa o login da conta. Métrica "por SDR" fica de
fora: com um vendedor, a conta é o vendedor.

## Estado atual (verificado em 2026-09-23)

Consulta somente leitura em produção, conta `adm.eleveone@gmail.com`
(`14448933-86df-47d4-a082-df69dbddeff1`):

- 1034 leads. O time já opera no sistema novo: 99 leads criados, 132 mensagens e
  43 mudanças de etapa desde 20/09. WhatsApp pela Evolution, conectado.
- 10 etapas, **nenhuma com `funnel_key`**: Prospecção, Respondeu, Interessado,
  Demonstração, Orçamento, Fechado, Não Respondeu, Não tem Interesse,
  lead morno / vai comprar, morreu na demonstração.
- `personal_tasks`: 5. A tabela não tem `lead_id`, então tarefa não aponta para lead.
- `objections`: 0. `workspace_members`: 0.
- `leads.last_touch_at` não é gravado por nenhum código do repositório. A última
  interação tem de sair de `messages`.

Não existe API para terceiros. Toda Edge Function autentica por JWT de usuário,
segredo interno ou webhook assinado (`_shared/auth.ts`). A única chave de servidor
do Supabase, a service role, lê e escreve **todas** as contas — não pode sair do
Supabase.

### Defeito achado no caminho: o Dashboard conta perda como avanço

`src/pages/Dashboard.tsx:202-227` classifica a etapa pelo `funnel_key` e, sem ele,
pelo nome: `includes("interess")` entra em Interessados, `includes("demonstr")` em
Demonstração. Na Eleve One, "Não tem **Interess**e" entra em Interessados, e
"morreu na **demonstr**ação" entraria em Demonstração. Nos últimos 7 dias, 9 leads
foram para Interessado e 3 para Não tem Interesse; o card soma os dois grupos.

Conserto para a Eleve One, sem código: marcar o `funnel_key` das etapas na tela de
etapas (`StageDialog.tsx` já tem o campo). Etapa com chave deixa de casar pelo
nome. Esta spec depende dessa marcação (Implantação, passo 1). O conserto geral da
heurística, para as contas que ainda vão migrar, fica como débito.

## Desenho

### Endpoint

```
GET https://xlycuunqpgpyfmafgajr.supabase.co/functions/v1/sales-coach
Authorization: Bearer <token>
```

Parâmetros de query, todos opcionais:

| parâmetro | padrão | limite | significado |
|---|---|---|---|
| `periodo_dias` | 30 | 1–90 | janela de novos leads, ganhos, perdas e resposta |
| `parado_dias` | 7 | 1–90 | dias sem interação para o lead contar como parado |
| `followup_horas` | 24 | 1–720 | horas desde a última mensagem do lead sem resposta |
| `limite` | 50 | 1–200 | tamanho máximo de cada lista |

- Só `GET`; qualquer outro método devolve 405.
- 401 para token ausente ou inválido, com o mesmo corpo nos dois casos.
- 400 para parâmetro fora do limite ou não numérico.
- 500 com mensagem genérica; o detalhe vai só para o log.
- `verify_jwt = false` no `config.toml`, como as outras funções: o token é nosso,
  não um JWT do Supabase.

### Token

- Gerado uma vez: 32 bytes aleatórios em base64url, com prefixo `efsc_` para ser
  reconhecível se vazar num log. Mostrado uma vez e gravado só no ambiente do
  servidor do Eleve Office. Nunca no navegador nem no front do avatar.
- O Supabase guarda só o SHA-256. Segredo `SALES_COACH_TOKENS`, um JSON
  `{"<sha256 hex>": "<user_id>"}`. Cada token fica preso a uma conta; cabe mais de
  um (o do Eleve Office e o do E2E).
- Validação: hash do token recebido, comparado com cada hash guardado por
  `constantTimeEqual` (`_shared/hmac.ts`). Casou, a conta é a do mapa. A conta
  **nunca** vem da requisição.
- Segredo ausente ou JSON inválido: tudo 401 (falha fechada).
- Revogar ou trocar: tirar ou substituir o hash no segredo.

Por que segredo e não tabela: há um consumidor só, e o segredo dispensa migration e
tela. Quando uma segunda conta quiser o coach, o caminho é uma tabela `api_tokens`
(hash, conta, escopos, revogado em, último uso).

### Consulta: uma função SQL por conta

`public.sales_coach_snapshot(p_user_id uuid, p_periodo_dias int, p_parado_dias int,
p_followup_horas int, p_limite int) returns jsonb`, `STABLE`, `SECURITY INVOKER`.

- Toda CTE filtra `user_id = p_user_id`; join só entre linhas da mesma conta.
- `REVOKE ALL ... FROM PUBLIC, anon, authenticated` e `GRANT EXECUTE ... TO
  service_role`. Sem isso, qualquer usuário logado chamaria a função pelo
  PostgREST passando o id de outra conta.
- A Edge Function chama por `createServiceRoleClient().rpc(...)` com o `user_id`
  resolvido pelo token.

Por que SQL e não várias queries do PostgREST: "última mensagem de cada lead" pede
`DISTINCT ON` ou janela, que o PostgREST não expressa; a função teria de puxar as
3 mil mensagens da conta. E o filtro de conta fica num lugar só, fácil de revisar.

### Definições

- **Etapa ativa:** sem `funnel_key`, ou com chave diferente de `won` e `lost`.
- **Última interação:** a mensagem mais recente do lead, em qualquer direção.
  Saída com `status = 'failed'` não conta. Sem mensagem, vale `leads.created_at`.
- **Follow-up atrasado:** lead em etapa ativa cuja última mensagem é `inbound` e
  tem mais de `followup_horas`. O lead falou por último e ninguém respondeu.
- **Lead parado:** lead em etapa ativa, fora das etapas `prospecting`, com a última
  interação há mais de `parado_dias`. Prospecção fica de fora porque tem centenas de
  leads frios esperando o primeiro contato — eles iam enterrar a lista.
- **Ganho / perda no período:** lead distinto com evento em `lead_stage_events`
  para etapa `won` / `lost` dentro da janela.
- **Motivo de perda:** o nome da etapa de perda onde o lead entrou. As etapas da
  Eleve One já são motivos ("Não tem Interesse", "morreu na demonstração").
- **Taxa de resposta:** a mesma definição do Dashboard (`calculateResponseRate`):
  leads que responderam entre os que receberam envio na janela.
- **Tarefa atrasada:** `personal_tasks` com `due_date` vencida e `completed_at` nulo.
- Ficam fora de todas as listas: `is_test`, e `is_suppressed` (opt-out ou número
  inválido — não há o que fazer com eles).

### Resposta

```json
{
  "gerado_em": "2026-09-23T22:30:00Z",
  "conta": "Eleve One",
  "periodo": { "dias": 30, "de": "2026-08-24T22:30:00Z", "ate": "2026-09-23T22:30:00Z" },
  "etapas_sem_classificacao": ["Respondeu", "lead morno / vai comprar"],
  "funil": [
    { "etapa": "Interessado", "tipo": "interested", "leads_agora": 9, "entradas_no_periodo": 9 }
  ],
  "resultado_periodo": { "leads_novos": 99, "ganhos": 0, "perdas": 3, "taxa_resposta": 0.18 },
  "perdas_por_motivo": [{ "motivo": "Não tem Interesse", "leads": 3 }],
  "totais": { "follow_ups_atrasados": 219, "leads_parados": 454, "tarefas_atrasadas": 0 },
  "follow_ups_atrasados": [
    {
      "lead_id": "…", "nome": "…", "empresa": "…", "cidade": "…", "etapa": "Interessado",
      "ultima_msg_do_lead_em": "…", "horas_sem_resposta": 30,
      "ultima_msg_do_lead": "trecho de até 200 caracteres"
    }
  ],
  "leads_parados": [
    { "lead_id": "…", "nome": "…", "empresa": "…", "etapa": "Demonstração",
      "ultimo_contato_em": "…", "dias_parado": 9 }
  ],
  "tarefas_atrasadas": [{ "titulo": "…", "vencimento": "…", "prioridade": "…" }]
}
```

`etapas_sem_classificacao` avisa o coach de que os números de ganho e perda estão
incompletos enquanto houver etapa sem chave. Listas ordenadas do atraso mais recente
para o mais antigo; `totais` traz o tamanho de cada lista antes do corte em `limite`
(decisão 4).

Sem telefone e sem e-mail: o coach sugere, quem age é o vendedor, pelo CRM.

### Código

- `supabase/functions/sales-coach/index.ts` — fino: método, token → conta,
  parâmetros, `rpc`, resposta. Log estruturado com conta, tamanho das listas e
  duração; sem dado de lead.
- `supabase/functions/_shared/sales-coach.ts` — puro: `resolveCoachAccount`
  (header + JSON do segredo → conta ou nulo) e `parseCoachParams`.
- `supabase/migrations/<timestamp>_sales_coach_snapshot.sql` — função e grants.
- `supabase/config.toml` — `[functions.sales-coach] verify_jwt = false`.

## Testes

Unitários (`tests/unit/sales-coach.test.ts`):

- token certo devolve a conta; errado, vazio, sem `Bearer` ou header ausente
  devolvem nulo;
- segredo ausente ou JSON quebrado devolve nulo;
- parâmetros: padrões, limites e texto não numérico.

E2E (`tests/e2e/sales-coach.spec.ts`, contra produção com o usuário de E2E, como a
suíte atual):

- sem token, 401; token errado, 401; `POST`, 405;
- com o token do E2E: lead semeado com mensagem `inbound` de 30 h atrás aparece em
  `follow_ups_atrasados`;
- **isolamento:** todo `lead_id` devolvido pertence ao usuário de E2E, conferido no
  banco com a chave secreta;
- `rpc('sales_coach_snapshot')` com JWT de usuário comum é negado — prova o REVOKE.

## Fora de escopo (v1)

- Qualquer escrita: criar tarefa, mover etapa, mandar mensagem.
- Métrica por vendedor.
- Tela para gerar e revogar token.
- Motivo de perda como campo próprio: a v1 usa a etapa de perda.
- Consertar em código a heurística de nome do Dashboard.

## Implantação

1. Dono marca as etapas na tela de etapas (tabela abaixo). Isso também conserta o
   card de funil do Dashboard. Feito em 2026-09-24 por SQL, a pedido do dono: 8
   etapas marcadas, "Respondeu" e "lead morno / vai comprar" sem chave.
2. Migration, função e testes; `bash scripts/sb-staging.sh db push` e
   `bash scripts/sb-staging.sh functions deploy sales-coach --use-api`.
3. Gerar os tokens (Eleve Office e E2E) e gravar os hashes em `SALES_COACH_TOKENS`.
   O token do Eleve Office vai direto para o ambiente da VPS dele, por SSH.
4. Conferir da VPS do Eleve Office: `curl` sem token dá 401, com token dá 200.

## Decisões do dono (2026-09-23)

1. **Mapeamento das etapas:**

   | etapa | `funnel_key` |
   |---|---|
   | Prospecção | `prospecting` |
   | Respondeu | sem chave (ativa) |
   | Interessado | `interested` |
   | Demonstração | `demo` |
   | Orçamento | `proposal` |
   | Fechado | `won` |
   | Não Respondeu | `lost` |
   | Não tem Interesse | `lost` |
   | lead morno / vai comprar | sem chave (ativa) |
   | morreu na demonstração | `lost` |

   "Não Respondeu" é perda: sai da lista de parados e aparece como motivo de perda.

2. **Trecho da última mensagem do lead:** vai para o coach, até 200 caracteres.
   Sem ele, o coach não sabe o que o lead pediu.

3. **Limiares padrão:** parado com 7 dias, follow-up atrasado com 24 h.

## Decisões do dono (2026-09-24)

4. **Ordem das listas e totais:** as três listas saem do atraso mais recente para o
   mais antigo, e a resposta ganha `totais` com o tamanho de cada lista antes do
   corte. Medido na Eleve One com o SQL da função: 219 follow-ups atrasados (7 da
   semana, 43 de 7–30 dias, 132 de 30–90, 37 com mais de 90) e 454 parados (95 de
   7–30 dias, 283 de 30–90, 76 com mais de 90). Na ordem anterior, com limite 50,
   o coach recebia só conversas de 73–100 dias do histórico migrado, e os
   follow-ups da semana não apareciam nem com `limite=200`.
