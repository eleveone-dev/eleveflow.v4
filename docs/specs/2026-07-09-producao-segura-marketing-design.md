# Spec — produção segura e operação de marketing

Data: 2026-07-09
Status: em implementação

## Contexto

O EleveFlow opera leads, automações e envios por WhatsApp com dados reais. A
revisão identificou endpoints privilegiados sem um perímetro consistente,
webhook sem autenticação própria, disparos sem governança suficiente e métricas
que não representam a conversão de uma coorte.

## Objetivos

1. Apenas rotinas internas autorizadas podem enviar mensagens, processar filas
   ou operar instâncias do WhatsApp.
2. Webhooks recebidos são autenticados, associados a uma conta e idempotentes.
3. Nenhum lead suprimido recebe novo envio; o operador escolhe campanha e fluxo
   antes de enfileirar contatos importados.
4. Dados de campanha, touchpoints e transições de pipeline permitem medir
   captação, resposta e conversão por origem.
5. O deploy passa por staging e gates executáveis antes de produção.

## Decisões

### Autorização de funções

- Funções iniciadas pelo navegador exigem JWT de usuário válido e ownership
  explícito dos recursos informados.
- Funções de worker exigem um segredo interno separado (`INTERNAL_FUNCTION_SECRET`)
  e nunca aceitam o anon key como autorização operacional.
- O webhook usa segredo próprio (`EVOLUTION_WEBHOOK_SECRET`) em header de
  assinatura/segredo. A instância recebida é mapeada para a conta antes de
  procurar o lead.
- O service role fica somente no servidor; ele não é uma credencial de entrada.

### Governança de contatos

- `leads` ganha estado de consentimento, supressão e opt-out, com timestamps e
  motivo.
- Uma lista de supressão é checada no backend antes de qualquer envio.
- A importação cria leads e, por padrão, não inicia comunicação. O operador
  seleciona campanha/fluxo e confirma uma prévia antes de enfileirar.

### Métricas de marketing

- `campaigns` descreve a iniciativa de marketing.
- `lead_touchpoints` registra origem, parâmetros de aquisição e contato.
- `lead_stage_events` registra mudanças de pipeline de forma imutável.
- O dashboard passa a calcular conversão por eventos e período, não por estágio
  atual ou rótulos de etapa.

### Rollout

1. Aplicar migration aditiva e secrets em staging.
2. Fazer smoke de webhook assinado, fluxo, fila e opt-out no staging.
3. Aplicar migration em produção somente após inventário de cron e confirmação
   de acesso à conta de produção.
4. Fazer smoke pós-deploy com uma conta de teste e monitorar erros/custos.

## Fora de escopo desta entrega

- Redesign visual amplo.
- Billing, multi-provider e reescrita completa do editor de fluxos.
- Garantia absoluta de ausência de incidentes; a meta é reduzir riscos
  conhecidos e liberar somente com evidências dos gates.
