# Runbook de release para produção

Este documento define o gate para publicar o EleveFlow. Ele não executa deploy
automaticamente: o frontend não tem provedor de hospedagem versionado no repositório,
e o projeto Supabase de produção exige uma conta autorizada separada. Essa separação é
intencional para impedir que uma validação de staging publique em produção por engano.

## Gate obrigatório

Só abra ou aprove uma release quando todos os itens abaixo estiverem verdes para o
mesmo commit.

| Gate                       | Como validar                              | Critério                                           |
| -------------------------- | ----------------------------------------- | -------------------------------------------------- |
| Dependências reproduzíveis | `npm ci` com Node definido em `.nvmrc`    | Sem alteração no lockfile                          |
| Tipos                      | `npm run typecheck`                       | Sucesso                                            |
| Lint                       | `npm run lint`                            | Zero erros e warnings aceitos conscientemente      |
| Testes unitários           | `npm run test:coverage`                   | Sucesso e thresholds configurados no Vitest        |
| Build                      | `npm run build`                           | Sucesso com as variáveis públicas do ambiente-alvo |
| Dependências de runtime    | `npm audit --omit=dev --audit-level=high` | Sem vulnerabilidade high ou critical               |
| Jornada integrada          | workflow **Staging E2E**                  | Sucesso no staging após a última mudança funcional |

O workflow [Verify](../.github/workflows/verify.yml) executa os cinco primeiros
gates em pull requests e no branch `main`. Ele inclui lint deliberadamente; não use
`continue-on-error` nem reduza a regra para esconder o baseline. Em 2026-07-13 o
lint está sem erros; os avisos legados devem ser acompanhados sem mascarar novos erros.

## E2E de staging

O workflow [Staging E2E](../.github/workflows/staging-e2e.yml) é manual porque ele
cria ou atualiza dados isolados de teste e exercita o agente. Crie o ambiente protegido
`staging` no GitHub e cadastre nele estes secrets:

- `STAGING_SUPABASE_URL`
- `STAGING_SUPABASE_PUBLISHABLE_KEY`
- `STAGING_SUPABASE_SECRET_KEY`
- `STAGING_EVOLUTION_WEBHOOK_SECRET`
- `STAGING_INTERNAL_FUNCTION_SECRET`

Execute o workflow com a confirmação `RUN_STAGING_E2E`. Nunca reutilize secrets de
produção nesse ambiente ou nos testes. Em Windows com o Avast interceptando TLS, siga
o procedimento em [staging.md](staging.md), incluindo `NODE_EXTRA_CA_CERTS`.
Os nomes legados `STAGING_SUPABASE_ANON_KEY` e `STAGING_SERVICE_ROLE_KEY` são aceitos
como fallback transitório pelo workflow, mas novos ambientes devem usar os nomes acima.

## Configuração da build de produção

Antes da build no provedor de hospedagem, configure apenas valores públicos no
cliente:

- `VITE_SUPABASE_URL`
- uma de `VITE_SUPABASE_ANON_KEY` ou `VITE_SUPABASE_PUBLISHABLE_KEY`

Uma service role, senha de banco, chave de Evolution, OpenRouter ou qualquer outro
segredo de servidor nunca pode usar o prefixo `VITE_`. Esses valores pertencem aos
secrets das Edge Functions no Supabase.

Confira que a URL aponta para o projeto de produção, e não para staging. O arquivo
`supabase/config.toml` é deliberadamente seguro por padrão e aponta para staging;
ele não é uma confirmação de destino de produção.

## Mudanças no Supabase

1. Obtenha acesso à conta de produção e faça um inventário somente de leitura de
   migrations, funções, cron jobs e secrets existentes.
2. Compare esse inventário com o staging e revise cada migration pendente. Não
   aplique migrations às cegas e não tente rollback destrutivo; prefira uma migration
   corretiva se houver falha.
   As migrations de identidade e fila fazem backfill e criam índices: estime o volume
   de `leads`/`send_queue` e use uma janela de manutenção se a base de produção for
   grande.
3. Use sempre o project ref de produção de forma explícita nos comandos da CLI. Não
   use o wrapper `scripts/sb-staging.sh` para produção.
4. Configure os secrets de produção antes de publicar as funções: gere valores
   independentes, com pelo menos 32 caracteres, para `EVOLUTION_WEBHOOK_SECRET` e
   `INTERNAL_FUNCTION_SECRET`. Confirme em particular que `EVOLUTION_MOCK` não está
   definido em produção.
5. Publique migrations e Edge Functions somente após a aprovação registrada, usando
   o ref de produção explícito. Não exponha valores de secrets no terminal, logs ou
   workflow.
6. Depois que as funções forem publicadas, grave em `global_settings` a URL daquele
   ambiente em `edge_functions_base_url` e o mesmo valor de
   `INTERNAL_FUNCTION_SECRET` em `edge_functions_internal_secret`, usando uma sessão
   administrativa segura. A migration remove deliberadamente os valores legados e os
   jobs ficam inativos até essa configuração existir.

## Ordem de publicação e smoke test

1. Gere e guarde o artefato da build aprovada.
2. Aplique as mudanças revisadas do Supabase e valide o estado das funções e cron jobs.
3. Publique o frontend com as variáveis públicas de produção.
4. Com uma conta e um lead de teste autorizados, valide login, criação ou consulta de
   lead, recebimento de webhook, uma mensagem de WhatsApp e a telemetria associada.
5. Monitore logs de Edge Functions, fila e erros de frontend durante a janela de
   publicação. Pause automações se houver comportamento inesperado.

Para rollback, reverta primeiro o frontend ao último artefato saudável e pause
automações. Para banco e Edge Functions, aplique uma correção versionada; não execute
comandos destrutivos ou uma reversão de schema sem backup e revisão.

## Aprovação

Registre no ticket ou PR: SHA publicado, responsável, horário, resultado de cada
gate, project ref confirmado, versão do artefato e resultado do smoke test. Se algum
gate falhar, a release fica bloqueada até que o defeito seja corrigido e todas as
validações relevantes sejam repetidas.
