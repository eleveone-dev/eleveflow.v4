# Ambiente de Staging

Projeto Supabase: `xlycuunqpgpyfmafgajr` (`eleveflow-marketing`, criado em
2026-07-14; região sa-east-1). É um ambiente isolado, sem dados nem schemas de
projetos anteriores.

Produção: `aoanpviozfabrrxjqayk`. **NUNCA** recebe `db push`/`functions deploy`
implícito. Deploy em produção só com `--project-ref` explícito, após validação aqui.

## Regras do ambiente local (Windows desta máquina)

1. **Avast intercepta TLS** (`aswMonFltProxy`). Sem workaround, `curl` falha com
   `CRYPT_E_NO_REVOCATION_CHECK` e o Supabase CLI com `Transport error`.
   - CA exportada em `.avast-ca.pem` (gitignored). Regenerar se sumir:
     certificado `Avast Web/Mail Shield Root` do store `Cert:\CurrentUser\Root`.
   - `curl`: usar `--ssl-no-revoke`.
   - CLI/Node: `NODE_EXTRA_CA_CERTS=<repo>/.avast-ca.pem` e
     `SSL_CERT_FILE=<repo>/.avast-ca.pem`.
2. **`.env` da raiz tem `SUPABASE_PROJECT_ID` de PRODUÇÃO** e o CLI 2.x carrega
   `.env` automaticamente — env var vence `config.toml` e o link. Por isso todo
   comando do CLI passa pelo wrapper:

   ```bash
   bash scripts/sb-staging.sh db push
   bash scripts/sb-staging.sh functions deploy
   bash scripts/sb-staging.sh secrets set CHAVE=valor
   ```

   No Windows, ele delega ao PowerShell para preservar o login seguro da CLI.
   O wrapper exporta `SUPABASE_PROJECT_ID` do staging e o CA do Avast. A senha
   do banco fica no gerenciador de credenciais nativo após `supabase link`;
   em CI, forneça `SUPABASE_DB_PASSWORD` explicitamente.

3. `supabase/config.toml` aponta para o staging por padrão (safe-by-default).

## Arquivos e segredos

- `.env.staging` (gitignored): `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_PUBLISHABLE_KEY`, `STAGING_SUPABASE_SECRET_KEY` e
  `STAGING_DB_PASSWORD`. Os nomes legados `VITE_SUPABASE_ANON_KEY` e
  `STAGING_SERVICE_ROLE_KEY` continuam aceitos temporariamente para transição.
- Atualize as chaves `STAGING_SUPABASE_SECRET_KEY` e
  `STAGING_DB_PASSWORD` locais antes de executar seeds/E2E que precisem de
  acesso administrativo. Não registre esses valores no repositório.
- Secrets das edge functions: `WHATSAPP_TOKEN_ENC_KEY` (32 bytes em base64) e
  `META_APP_SECRET`. Sem a primeira o `process-queue` nem inicia; sem a segunda o
  webhook da Meta responde 503. Ver `docs/meta-whatsapp-setup.md`.
- Antes de publicar as Edge Functions endurecidas, configure também
  `INTERNAL_FUNCTION_SECRET` (valor aleatório com
  aleatórios e com pelo menos 32 caracteres). Grave o segundo valor em
  `global_settings.edge_functions_internal_secret`; a URL do ambiente vai em
  `global_settings.edge_functions_base_url`. Não coloque nenhum deles em
  variáveis `VITE_`, URLs ou logs.

## Histórico de migrations

O projeto tinha migrations do delivery (`0001`-`0004`), marcadas como `reverted`
via `supabase migration repair` em 2026-07-06. Todas as migrations do
eleve.flow2 aplicadas na sequência.

## Seed de teste

```bash
set -a; source .env.staging; set +a
SUPABASE_URL="$VITE_SUPABASE_URL" SUPABASE_SECRET_KEY="${STAGING_SUPABASE_SECRET_KEY:-$STAGING_SERVICE_ROLE_KEY}" \
NODE_EXTRA_CA_CERTS="$(pwd)/.avast-ca.pem" node scripts/seed-staging.mjs
```

Cria (idempotente): usuário `e2e@eleveflow.test` / `e2e-password-123`
(onboarding completo), stage "Novo", lead "Lead E2E" telefone `5511999990000`.

## Smoke do webhook

Verificação de inscrição (GET), que a Meta faz ao registrar o callback:

```bash
set -a; source .env.staging; set +a
curl -s --ssl-no-revoke   "$VITE_SUPABASE_URL/functions/v1/meta-whatsapp-webhook?hub.mode=subscribe&hub.verify_token=$STAGING_META_WEBHOOK_VERIFY_TOKEN&hub.challenge=12345"
```

Resposta esperada: exatamente `12345`. Com token errado: HTTP 403.

O POST de evento exige a assinatura `X-Hub-Signature-256` (HMAC-SHA256 do corpo
cru com o App Secret) — ver `tests/e2e/meta-inbound-webhook.spec.ts`, que monta e
assina o payload.

