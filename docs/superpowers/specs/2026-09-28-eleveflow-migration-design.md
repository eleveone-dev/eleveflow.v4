# Migração do Eleve Flow

## Objetivo

Publicar o Eleve Flow em `https://eleveflow.eleveone.com.br`, com o código no repositório `eleveone-dev/eleveflow.v4`, a aplicação na VPS e o backend em um novo projeto Supabase da conta `adm.eleveone@gmail.com`.

## Fonte de dados

O arquivo `eleve.flow2.rar` é a fonte aprovada. Os CSVs em `migracao/` representam o estado de 16 de julho de 2026 e incluem contas, leads, fluxos, blocos, execuções, etapas, mensagens, fila de envio, tarefas, configurações e logs. Dados posteriores a essa data não fazem parte deste escopo.

`account_secrets.csv` não será versionado, copiado para o repositório ou exibido em logs. Ele será tratado como material sensível durante a importação e as credenciais de terceiros serão rotacionadas quando necessário.

## Arquitetura alvo

- **Supabase gerenciado:** novo projeto na conta indicada, com Postgres, Auth, Storage, Realtime e Edge Functions.
- **VPS:** contêiner da aplicação e proxy reverso com HTTPS; somente as portas públicas 80 e 443 ficam expostas.
- **GitHub:** código saneado, sem `.env`, exports de clientes ou tokens, enviado ao remoto fornecido.
- **DNS:** `eleveflow.eleveone.com.br` aponta à VPS; os redirecionamentos de Auth usam esse domínio.

## Migração

1. Criar o projeto Supabase e configurar URL de produção, Auth e Storage.
2. Aplicar as migrações SQL em ordem, publicar as Edge Functions e configurar os segredos novos.
3. Importar os CSVs em ordem de dependência, preservando UUIDs e relações. Os arquivos de contas e integrações sensíveis recebem validação e rotação antes de serem ativados.
4. Atualizar a configuração do app para o novo projeto Supabase e remover acoplamentos ao domínio Lovable.
5. Construir e testar a aplicação; publicar na VPS atrás de HTTPS.
6. Validar login, CRM, fluxos, fila, mensagens, storage e chamadas às funções. Ativar backups automatizados na VPS e documentar recuperação.

## Limites e critérios de aceite

- O sistema não terá dependência operacional do Lovable.
- Os dados do snapshot de 16/07 serão preservados, exceto credenciais de terceiros que precisem ser substituídas.
- O domínio responderá com certificado HTTPS válido.
- Nenhum segredo ou dado de cliente será enviado ao GitHub.
- A publicação somente ocorre depois de validação funcional básica e backup recuperável.
