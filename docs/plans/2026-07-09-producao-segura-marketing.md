# Plano — produção segura e operação de marketing

## Atualização de execução — 2026-07-13

- [x] Fases 1 e 2 implementadas no código e nas migrations de staging: autenticação
      explícita, isolamento de tenant, consentimento/opt-out, webhook assinado e métricas.
- [x] Fila endurecida com claim atômico, lease por token, finalização transacional,
      proteção contra cancelamento concorrente, limites de envio e identidade de telefone
      normalizada.
- [x] Migrations `20260709120000`, `20260713120000` e `20260713123000` aplicadas e
      validadas por `db lint` no staging.
- [x] Gates locais: Deno check, typecheck, lint sem erros, 55 testes unitários,
      cobertura 96,39%, build e audit sem vulnerabilidades high/critical.
- [ ] Deploy das Edge Functions, configuração dos secrets e E2E real no staging:
      aguardando autenticação da Supabase CLI.
- [ ] Produção: exige acesso e aprovação separados após o staging verde.

## Fase 1 — bloqueadores de produção

- [ ] Restringir Edge Functions privilegiadas a usuários autorizados ou chamadas internas autenticadas.
- [ ] Validar webhook da Evolution e isolar por instância/conta.
- [ ] Remover bypass de ownership no disparo manual.
- [ ] Bloquear processamento de filas e proxy do WhatsApp por anon key.
- [ ] Eliminar defaults de URL/chave de produção nas migrations.

## Fase 2 — governança e mensuração

- [ ] Adicionar consentimento, opt-out e supressão ao modelo de leads.
- [ ] Criar campanhas, touchpoints e eventos de mudança de pipeline.
- [ ] Registrar `updated_at` de leads no banco.
- [ ] Tornar a importação revisão/seleção de campanha antes de enfileirar.
- [ ] Corrigir o dashboard para usar eventos e atribuição.

## Fase 3 — validação

- [ ] Unit tests para autorização, supressão e métricas puras.
- [ ] Typecheck de frontend e Edge Functions.
- [ ] Lint limpo ou baseline explicitamente reduzido.
- [ ] E2E de webhook assinado, opt-out, fluxo e fila no staging.
- [ ] Build verde.

## Fase 4 — produção

- [ ] Inventário read-only de cron e secrets da conta de produção.
- [ ] Migration e deploy de funções na produção.
- [ ] Smoke pós-deploy com conta de teste.
- [ ] Monitoramento de erros, fila e custo nas primeiras 24 horas.
