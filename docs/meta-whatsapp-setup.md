# Configuração do WhatsApp Cloud API (Meta)

Documento operacional: o que o dono precisa criar no painel da Meta e o que
precisa existir no Supabase para o Bloco B destravar.

**Nenhum valor real entra neste arquivo.** Segredos vão para os secrets do
Supabase ou para `global_settings` (criptografados quando for token).

## 1. Dados que só o dono consegue obter

| Dado | Onde achar no painel da Meta |
|---|---|
| `META_APP_ID` | developers.facebook.com › Meus Apps › o app › Configurações › Básico › **ID do aplicativo** |
| `META_APP_SECRET` | mesma tela › **Chave secreta do aplicativo** › "Mostrar" |
| WABA ID | Painel do app › WhatsApp › Configuração da API › **ID da conta do WhatsApp Business** |
| Phone Number ID | mesma tela › seletor "Número de telefone" › **Identificação do número de telefone** |
| Access token | mesma tela (token temporário de 24 h) ou System User token permanente em business.facebook.com › Configurações do negócio › Usuários › Usuários do sistema |
| Config ID (Embedded Signup) | Painel do app › WhatsApp › Configuração do Embedded Signup |

Atenção: o **Phone Number ID não é o número de telefone**. É um id numérico
separado, e é ele que vai em `whatsapp_connections.phone_number_id`.

## 2. Webhook

- **Callback URL:** `https://<project-ref>.supabase.co/functions/v1/meta-whatsapp-webhook`
- **Verify token:** gerar com `generateWebhookVerifyToken()`
  (`supabase/functions/_shared/platform-role.ts`) — 64 caracteres hex — e gravar em
  `global_settings.meta_webhook_verify_token` antes de registrar na Meta.
- **Campo a assinar:** `messages`.
- A Meta valida a inscrição com um `GET` (`hub.mode=subscribe`, `hub.verify_token`,
  `hub.challenge`); a função responde o `hub.challenge` em texto puro.
- Todo `POST` é autenticado por `X-Hub-Signature-256` (HMAC-SHA256 do corpo cru com
  o App Secret). Assinatura ausente ou inválida → 401; App Secret não configurado
  → 503 (falha fechada, nunca aceita sem verificar).

## 3. Secrets do Supabase

| Secret | Para quê | Obrigatório |
|---|---|---|
| `WHATSAPP_TOKEN_ENC_KEY` | chave AES-256-GCM que cifra os tokens em `whatsapp_connections.access_token_encrypted`. **32 bytes em base64** | sim — sem ela `process-queue` nem inicia |
| `META_APP_SECRET` | verificação da assinatura do webhook, quando não estiver cifrado em `global_settings.meta_app_secret_encrypted` | sim |
| `META_GRAPH_API_VERSION` | fallback da versão da Graph API | não (default `v25.0`) |

Gerar a chave de criptografia:

```bash
openssl rand -base64 32
```

Guardar em local seguro **antes** de gravar: perdê-la torna todo token cifrado
irrecuperável, e cada tenant precisa reconectar.

## 4. Configuração em `global_settings`

| Chave | Conteúdo |
|---|---|
| `meta_graph_api_version` | versão da Graph API, ex.: `v25.0` (semeada pela migration) |
| `meta_webhook_verify_token` | token de verificação do webhook, texto puro |
| `meta_app_secret_encrypted` | App Secret cifrado com `encryptSecret` (opcional; sem ele vale o secret de ambiente) |

`global_settings` tem RLS e `GRANT SELECT` só para `service_role` — nada disso
chega ao browser.

## 5. Conexão de um tenant

Uma linha em `public.whatsapp_connections` por tenant:

- `tenant_id` = `auth.users.id` da empresa;
- `phone_number_id`, `waba_id`;
- `access_token_encrypted` = `encryptSecret(<token>, WHATSAPP_TOKEN_ENC_KEY)`;
- `status = 'connected'`.

Sem linha conectada o tenant **não envia nem recebe**: `resolveProvider` responde
409 e o item da fila vai para `failed` com motivo `no_whatsapp_connection`. Não
existe caminho alternativo — a Evolution saiu do produto.

O token nunca chega ao cliente: o `GRANT SELECT` por coluna omite
`access_token_encrypted`, e a policy só deixa o tenant ler a própria linha.

## 6. Superadmin

As telas administrativas (Bloco B, Fase 2) exigem
`app_metadata.platform_role = 'superadmin'`. Semear com:

```bash
SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/set-superadmin.mjs <email>
```

O usuário precisa renovar a sessão para o claim aparecer no token. O gate real é
`requireSuperadmin` no servidor; o hook `useIsSuperadmin` é só cosmético.

## 7. O que ainda não existe

Bloco B, cada fase travada na sua credencial: tela de configuração, conexão
administrativa, Embedded Signup, envio de mídia/templates, gestão de modelos e os
dois vídeos de análise da Meta. Ver
`docs/specs/2026-07-24-migracao-whatsapp-meta-cloud-design.md`.
