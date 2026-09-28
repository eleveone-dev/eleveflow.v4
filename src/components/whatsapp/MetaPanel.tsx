// Painel da conexão oficial (Meta Cloud API).
//
// Extraído da página em 2026-09-18, quando a tela passou a ramificar por
// provedor: a Evolution virou o caminho ativo e este continua alcançável para
// as contas que têm linha `meta_cloud`. Nada aqui mudou de comportamento.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Check, Copy, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectionChain, type ChainLink } from "@/components/whatsapp/ConnectionChain";
import { MetaConnectionForm } from "@/components/whatsapp/MetaConnectionForm";
import { MetaEmbeddedSignupButton } from "@/components/whatsapp/MetaEmbeddedSignupButton";
import { cn } from "@/lib/utils";
import {
  appEnvironment,
  useWhatsappConnection,
  type ConnectionState,
} from "@/hooks/use-whatsapp-connection";

const ENVIRONMENT_LABEL: Record<string, string> = {
  development: "Desenvolvimento",
  preview: "Preview",
  production: "Produção",
};

function buildLinks(state: ConnectionState): ChainLink[] {
  const { checks } = state;
  const verified = state.verifiedAt
    ? `confirmado pela Meta em ${new Date(state.verifiedAt).toLocaleString("pt-BR")}`
    : "sem verificação registrada";

  return [
    {
      id: "credentials",
      label:
        checks.credentials === "ok" ? "Credenciais configuradas" : "Credenciais não configuradas",
      state: checks.credentials,
      provenance:
        checks.credentials === "ok"
          ? "token guardado criptografado no servidor"
          : "nenhum access token gravado para esta conta",
    },
    {
      id: "connection",
      label: checks.connection === "ok" ? "Conexão validada" : "Conexão não validada",
      state: checks.connection,
      provenance:
        checks.connection === "ok"
          ? `token aceito e WABA acessível — ${verified}`
          : checks.connection === "failed"
            ? (state.error?.message ?? "a Meta recusou o token")
            : "depende das credenciais",
    },
    {
      id: "phone",
      label: checks.phoneNumber === "ok" ? "Número encontrado" : "Número não encontrado",
      state: checks.phoneNumber,
      provenance:
        checks.phoneNumber === "ok"
          ? `${state.phoneNumber?.displayPhoneNumber ?? "número sem rótulo"} — ${verified}`
          : checks.phoneNumber === "missing"
            ? "nenhum Phone Number ID associado"
            : checks.phoneNumber === "failed"
              ? "a Meta não reconheceu o Phone Number ID gravado"
              : "depende da conexão validada",
    },
    {
      id: "webhook",
      label: checks.webhook === "ok" ? "Webhook inscrito" : "Webhook não inscrito",
      state: checks.webhook,
      provenance:
        checks.webhook === "ok"
          ? `app aparece em subscribed_apps da WABA — ${verified}`
          : checks.webhook === "failed"
            ? "o app não aparece entre os inscritos na WABA"
            : "depende da conexão validada",
    },
    {
      id: "outbound",
      label: checks.outbound === "ok" ? "Envio testado" : "Envio ainda não testado",
      state: checks.outbound,
      provenance: state.outboundProof
        ? `${
            state.outboundProof.status === "sent" ? "Aceita" : "Entregue"
          } pela Meta em ${new Date(state.outboundProof.at).toLocaleString("pt-BR")}`
        : "Será liberado depois da conexão oficial",
    },
    {
      id: "inbound",
      label: checks.inbound === "ok" ? "Recebimento testado" : "Recebimento ainda não testado",
      state: checks.inbound,
      provenance: state.inboundProof
        ? `Webhook da Meta recebido em ${new Date(state.inboundProof.at).toLocaleString("pt-BR")}`
        : "Será liberado após receber uma mensagem pelo webhook da Meta",
    },
  ];
}

function headline(state: ConnectionState): { line: string; tone: string } {
  if (!state.configured) {
    return { line: "WhatsApp oficial ainda não configurado", tone: "text-muted-foreground" };
  }
  if (state.checks.connection === "failed") {
    return { line: "A Meta recusou esta conexão", tone: "text-[#f87171]" };
  }
  if (state.checks.phoneNumber !== "ok") {
    return { line: "Conexão sem número confirmado", tone: "text-[#fbbf24]" };
  }
  if (state.checks.outbound !== "ok" || state.checks.inbound !== "ok") {
    return { line: "Número confirmado, tráfego ainda não provado", tone: "text-[#fbbf24]" };
  }
  return { line: "Número confirmado e em uso", tone: "text-[#34d399]" };
}

function CopyableId({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      {value ? (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          }}
          className="group flex items-center gap-2 rounded-md font-mono text-sm text-foreground transition-colors hover:text-[#a78bfa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label={`Copiar ${label}`}
        >
          <span className="truncate">{value}</span>
          {copied ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-[#34d399]" aria-hidden />
          ) : (
            <Copy
              className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60"
              aria-hidden
            />
          )}
        </button>
      ) : (
        <p className="font-mono text-sm text-muted-foreground">—</p>
      )}
    </div>
  );
}

export function MetaPanel() {
  const { data: state, isLoading, isFetching, refetch, error } = useWhatsappConnection();
  const [formOpen, setFormOpen] = useState(false);
  const environment = appEnvironment();
  const queryClient = useQueryClient();

  // Inscrever o app nos webhooks da WABA é uma ação à parte da conexão: a Meta
  // não faz isso sozinha, e sem ela nada é recebido.
  const subscribe = useMutation<void, Error, void>({
    mutationFn: async () => {
      const { data, error: fnError } = await supabase.functions.invoke("meta-whatsapp-admin", {
        body: { action: "subscribe-webhook" },
      });
      if (fnError) throw new Error(fnError.message);
      if (data?.success === false) throw new Error(data.error ?? "Falha ao inscrever o webhook");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["whatsapp-connection-state"] }),
  });

  if (isLoading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-9 w-80" />
        <div className="space-y-6 pt-4">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex gap-4">
              <Skeleton className="mt-1 h-3 w-3 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-52" />
                <Skeleton className="h-3 w-72" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error || !state) {
    return (
      <div>
        <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
          <div className="space-y-1">
            <p className="font-medium">Não foi possível verificar a conexão</p>
            <p className="text-sm text-muted-foreground">
              {(error as Error)?.message ?? "Resposta vazia do diagnóstico"}
            </p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
              Tentar de novo
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const verdict = headline(state);
  const links = buildLinks(state);

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
              WhatsApp Business · Cloud API
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] tracking-normal">
                {ENVIRONMENT_LABEL[environment]}
              </span>
            </p>
            <h1 className={cn("text-3xl font-semibold tracking-tight sm:text-4xl", verdict.tone)}>
              {verdict.line}
            </h1>
            {state.verifiedAt ? (
              <p className="text-sm text-muted-foreground">
                Verificado na Meta em {new Date(state.verifiedAt).toLocaleString("pt-BR")}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Nenhuma verificação feita ainda.</p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="shrink-0"
          >
            <RefreshCw className={cn("mr-2 h-4 w-4", isFetching && "animate-spin")} aria-hidden />
            Atualizar
          </Button>
        </div>

        {state.error && state.checks.connection === "failed" && (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <span>
              {state.error.code && (
                <span className="mr-2 font-mono text-xs text-muted-foreground">
                  código {state.error.code}
                </span>
              )}
              {state.error.message}
            </span>
          </p>
        )}
      </header>

      <section aria-labelledby="chain-heading" className="space-y-5">
        <h2 id="chain-heading" className="text-sm font-medium text-muted-foreground">
          Cada item mostra de onde veio a informação
        </h2>
        <ConnectionChain links={links} />
      </section>

      {state.checks.phoneNumber === "ok" && (
        <section
          aria-labelledby="ids-heading"
          className="space-y-5 rounded-xl border border-border bg-card p-6"
        >
          <h2 id="ids-heading" className="text-sm font-medium">
            Dados devolvidos pela Meta
          </h2>
          <div className="grid gap-5 sm:grid-cols-2">
            <CopyableId label="Phone Number ID" value={state.phoneNumber?.phoneNumberId ?? null} />
            <CopyableId label="WABA ID" value={state.waba?.wabaId ?? null} />
            <CopyableId
              label="Número visível"
              value={state.phoneNumber?.displayPhoneNumber ?? null}
            />
            <CopyableId label="Nome verificado" value={state.phoneNumber?.verifiedName ?? null} />
          </div>
          <dl className="grid gap-5 border-t border-border pt-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                Qualidade
              </dt>
              <dd className="mt-1">{state.phoneNumber?.qualityRating ?? "ainda não calculada"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                Expiração do token
              </dt>
              <dd className="mt-1">
                {state.tokenExpiresAt
                  ? new Date(state.tokenExpiresAt).toLocaleString("pt-BR")
                  : "sem expiração"}
              </dd>
            </div>
          </dl>
        </section>
      )}

      {state.checks.phoneNumber === "ok" && state.checks.webhook !== "ok" && (
        <section className="space-y-3 rounded-xl border border-[#fbbf24]/30 bg-[#fbbf24]/[0.05] p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium">Webhook não inscrito</h2>
              <p className="text-sm text-muted-foreground">
                O número está confirmado, mas as mensagens recebidas não chegam ao CRM enquanto o
                app não estiver inscrito nesta conta.
              </p>
            </div>
            <Button
              onClick={() => subscribe.mutate()}
              disabled={subscribe.isPending}
              className="shrink-0"
            >
              {subscribe.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Inscrever o app nesta conta
            </Button>
          </div>
          {subscribe.isError && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {subscribe.error.message}
            </p>
          )}
        </section>
      )}

      <MetaEmbeddedSignupButton />

      <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-dashed border-border p-6">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">
            {state.configured ? "Trocar as credenciais" : "Nenhuma credencial gravada"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            O passo a passo está em{" "}
            <span className="font-mono text-xs text-foreground">docs/meta-whatsapp-setup.md</span>.
          </p>
        </div>
        <Button
          variant={state.configured ? "outline" : "default"}
          onClick={() => setFormOpen(true)}
        >
          Configurar conexão de desenvolvimento
        </Button>
      </section>

      <MetaConnectionForm open={formOpen} onOpenChange={setFormOpen} />
    </div>
  );
}
