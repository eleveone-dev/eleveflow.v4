import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, QrCode, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildLoginParams,
  isTrustedMetaOrigin,
  parseSignupEvent,
  type SignupEvent,
} from "@/lib/meta-embedded-signup";
import { useQueryClient } from "@tanstack/react-query";
import { usePublicMetaConfig } from "@/hooks/use-meta-public-config";
import { supabase } from "@/integrations/supabase/client";

interface ConnectedResult {
  wabaId: string;
  phoneNumber: {
    phoneNumberId: string;
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    qualityRating: string | null;
  };
  otherNumbers: Array<{ phoneNumberId: string; displayPhoneNumber: string | null }>;
}

declare global {
  interface Window {
    FB?: {
      init: (params: Record<string, unknown>) => void;
      login: (callback: (response: unknown) => void, params: Record<string, unknown>) => void;
    };
    fbAsyncInit?: () => void;
  }
}

const SDK_ID = "facebook-jssdk";

/**
 * Etapas 4B e 4C: abre o fluxo oficial, captura o código e o troca pelo token do
 * cliente no servidor, exibindo os ativos que foram autorizados.
 *
 * Deliberadamente NÃO faz: persistir WABA ou número, inscrever o app na WABA,
 * nem alterar o provider ativo. Isso é 4D em diante — por isso o aviso na
 * interface diz que a conexão ainda não é gravada.
 */
export function MetaEmbeddedSignupButton() {
  const { data: config, isLoading } = usePublicMetaConfig();
  const queryClient = useQueryClient();
  const [sdkState, setSdkState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [lastEvent, setLastEvent] = useState<SignupEvent | null>(null);
  const [rejectedOrigin, setRejectedOrigin] = useState<string | null>(null);
  const lastEventRef = useRef<SignupEvent | null>(null);
  const [exchange, setExchange] = useState<
    | { state: "idle" }
    | { state: "running" }
    | { state: "done"; result: ConnectedResult }
    | { state: "failed"; message: string }
  >({ state: "idle" });
  const [discovery, setDiscovery] = useState<
    | { state: "idle" }
    | { state: "running" }
    | { state: "done"; phone: string | null; alreadyConnected: boolean }
    | { state: "failed"; message: string }
  >({ state: "idle" });
  const initialized = useRef(false);

  const runDiscovery = useCallback(() => {
    setDiscovery({ state: "running" });
    void supabase.functions
      .invoke("meta-whatsapp-admin", { body: { action: "discover-connection" } })
      .then(({ data, error }) => {
        if (error) throw new Error(error.message);
        if (data?.success === false) {
          throw new Error(data.error ?? "Não foi possível encontrar a conexão");
        }
        setDiscovery({
          state: "done",
          phone: data?.connection?.displayPhoneNumber ?? null,
          alreadyConnected: data?.alreadyConnected === true,
        });
        void queryClient.invalidateQueries({ queryKey: ["whatsapp-connection-state"] });
      })
      .catch((err: Error) => setDiscovery({ state: "failed", message: err.message }));
  }, [queryClient]);

  // Ouve as mensagens do pop-up. A validação de origem vem antes de qualquer
  // leitura do payload: dado de janela não confiável não é nem parseado.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isTrustedMetaOrigin(event.origin)) {
        if (typeof event.data === "string" && event.data.includes("WA_EMBEDDED_SIGNUP")) {
          setRejectedOrigin(event.origin || "origem vazia");
        }
        return;
      }
      const parsed = parseSignupEvent(event.data);
      if (parsed) {
        lastEventRef.current = parsed;
        setLastEvent(parsed);
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!config?.enabled || !config.appId || initialized.current) return;
    initialized.current = true;
    setSdkState("loading");

    window.fbAsyncInit = () => {
      window.FB?.init({
        appId: config.appId,
        autoLogAppEvents: true,
        xfbml: true,
        version: config.graphApiVersion,
      });
      setSdkState("ready");
    };

    if (document.getElementById(SDK_ID)) {
      setSdkState("ready");
      return;
    }

    const script = document.createElement("script");
    script.id = SDK_ID;
    script.src = "https://connect.facebook.net/pt_BR/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => setSdkState("failed");
    document.body.appendChild(script);
  }, [config]);

  const launch = useCallback(() => {
    if (!config || !window.FB) return;
    lastEventRef.current = null;
    setLastEvent(null);
    setRejectedOrigin(null);
    setExchange({ state: "idle" });

    window.FB.login(
      (response: unknown) => {
        const code = (response as { authResponse?: { code?: string } })?.authResponse?.code;
        if (!code) return;

        // O código vive 30 segundos: trocar imediatamente, sem confirmação de
        // tela no meio. O App Secret fica no servidor, então a troca é lá.
        setExchange({ state: "running" });
        void supabase.functions
          .invoke("meta-whatsapp-admin", {
            body: {
              action: "exchange-code",
              code,
              coexistence:
                lastEventRef.current?.kind === "finish" ? lastEventRef.current.coexistence : false,
              phoneNumberId:
                lastEventRef.current?.kind === "finish" ? lastEventRef.current.phoneNumberId : null,
            },
          })
          .then(({ data, error }) => {
            if (error) throw new Error(error.message);
            if (data?.success === false) throw new Error(data.error ?? "Falha na troca do código");
            setExchange({ state: "done", result: data.connected as ConnectedResult });
            void queryClient.invalidateQueries({ queryKey: ["whatsapp-connection-state"] });
          })
          .catch((err: Error) => setExchange({ state: "failed", message: err.message }));
      },
      buildLoginParams(config) as unknown as Record<string, unknown>,
    );
  }, [config]);

  if (isLoading) return null;

  if (!config?.enabled) {
    return (
      <section className="rounded-xl border border-dashed border-border p-6">
        <h2 className="text-sm font-medium">Conexão oficial indisponível</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          O Embedded Signup está desabilitado. Um administrador precisa preencher App ID e
          Configuration ID em Configurações › Integrações.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border border-[#7c3aed]/30 bg-[#7c3aed]/[0.04] p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-medium">Conectar o WhatsApp</h2>
          <p className="text-sm text-muted-foreground">
            O número continua funcionando no aplicativo WhatsApp Business do celular. Você atende
            pelo aparelho, o sistema atende pelo CRM.
          </p>
        </div>
        <Button
          onClick={launch}
          disabled={sdkState !== "ready"}
          className="shrink-0 bg-[#7c3aed] font-medium hover:bg-[#6d28d9]"
        >
          {sdkState === "loading" && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          Conectar número
        </Button>
      </div>

      {sdkState === "failed" && (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Não foi possível carregar o SDK da Meta. Verifique bloqueadores de script e tente de novo.
        </p>
      )}

      {/* No Embedded Signup v4 não existe tela "conectar conta existente": a
          coexistência é decidida pelo número digitado, e só a tela seguinte
          revela qual caminho a Meta escolheu. Por isso o passo a passo leva até
          essa tela em vez de mandar parar antes dela. */}
      <div className="space-y-4 rounded-lg border border-border bg-background/40 p-4">
        <h3 className="text-sm font-medium">Como conectar</h3>

        <ol className="space-y-3 text-sm text-muted-foreground">
          {[
            <>
              Clique em <strong className="font-medium text-foreground">Conectar número</strong> e
              entre com a conta Meta da empresa.
            </>,
            <>
              Escolha{" "}
              <strong className="font-medium text-foreground">Adicionar um novo número</strong>. É
              esse mesmo, apesar do nome: a Meta reconhece o número existente pelo que você digitar.
            </>,
            <>
              Digite o número que já atende no WhatsApp Business. A próxima tela mostra qual caminho
              a Meta escolheu:
            </>,
          ].map((text, index) => (
            <li key={index} className="flex gap-3">
              <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[11px] text-foreground">
                {index + 1}
              </span>
              <span>{text}</span>
            </li>
          ))}
        </ol>

        {/* O ponto de decisão do fluxo. Nenhuma outra tela distingue conectar de
            transferir, então ele aparece como bifurcação e não como parágrafo. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 rounded-lg border border-[#34d399]/40 bg-[#34d399]/[0.06] p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-[#34d399]">
              <QrCode className="h-4 w-4 shrink-0" aria-hidden />
              Perfil da empresa e QR Code
            </p>
            <p className="text-xs text-muted-foreground">
              Caminho certo. O número continua no celular. Siga para o passo 4.
            </p>
          </div>
          <div className="space-y-1.5 rounded-lg border border-[#f87171]/40 bg-[#f87171]/[0.06] p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-[#f87171]">
              <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
              Código por SMS ou ligação
            </p>
            <p className="text-xs text-muted-foreground">
              Feche a janela sem preencher. Esse caminho tira o número do celular e apaga o
              histórico de conversas.
            </p>
          </div>
        </div>

        <ol className="space-y-3 text-sm text-muted-foreground">
          {[
            <>
              No celular chega uma mensagem da conta oficial do Facebook: toque em{" "}
              <strong className="font-medium text-foreground">Conectar</strong> e escaneie o QR Code
              exibido na tela.
            </>,
            <>
              Quando perguntar sobre o histórico de conversas, escolha{" "}
              <strong className="font-medium text-foreground">não compartilhar</strong>. O sistema
              não importa conversas antigas e a escolha não pode ser desfeita.
            </>,
            <>
              Conclua o cadastro: nome da conta, fuso horário e termos. O pareamento leva alguns
              minutos.
            </>,
          ].map((text, index) => (
            <li key={index} className="flex gap-3">
              <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[11px] text-foreground">
                {index + 4}
              </span>
              <span>{text}</span>
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            className="font-medium"
            disabled={discovery.state === "running"}
            onClick={runDiscovery}
          >
            {discovery.state === "running" && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            )}
            Concluí na Meta, buscar conexão
          </Button>
          <span className="text-xs text-muted-foreground">
            Use se a janela fechou antes de confirmar.
          </span>
        </div>

        {discovery.state === "failed" && (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {discovery.message}
          </p>
        )}

        {discovery.state === "done" && (
          <p className="flex items-start gap-2 text-sm">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#34d399]" aria-hidden />
            <span>
              {discovery.alreadyConnected
                ? "Já estava conectado: "
                : "Conectado por coexistência: "}
              <strong>{discovery.phone ?? "número sem identificação"}</strong>
            </span>
          </p>
        )}
      </div>

      <p className="rounded-lg border border-[#fbbf24]/30 bg-[#fbbf24]/[0.06] p-3 text-xs text-[#fbbf24]">
        Concluir este fluxo conecta o número de verdade. O WhatsApp Web e o Desktop são
        desvinculados e precisam ser reconectados depois; o celular continua funcionando
        normalmente. Mantenha o aplicativo instalado e abra-o ao menos uma vez a cada duas semanas —
        aparelho parado faz a Meta encerrar a conexão.
      </p>

      {exchange.state === "running" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Trocando o código pela autorização do cliente…
        </p>
      )}

      {exchange.state === "failed" && (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {exchange.message}
        </p>
      )}

      {exchange.state === "done" && (
        <div className="space-y-2 rounded-lg border border-[#34d399]/30 bg-[#34d399]/[0.06] p-4 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <ShieldCheck className="h-4 w-4 text-[#34d399]" aria-hidden />
            Número conectado e gravado
          </p>
          <p className="text-muted-foreground">
            {exchange.result.phoneNumber.displayPhoneNumber ?? "número sem rótulo"}
            {exchange.result.phoneNumber.verifiedName
              ? ` · ${exchange.result.phoneNumber.verifiedName}`
              : ""}
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            WABA {exchange.result.wabaId} · Phone Number ID{" "}
            {exchange.result.phoneNumber.phoneNumberId}
          </p>
          {exchange.result.otherNumbers.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Outros {exchange.result.otherNumbers.length} número(s) nesta conta não foram
              conectados.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Falta inscrever o app nos webhooks desta conta para receber mensagens.
          </p>
        </div>
      )}

      {lastEvent && (
        <div className="space-y-1 rounded-lg border border-border bg-card p-4 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <ShieldCheck className="h-4 w-4 text-[#34d399]" aria-hidden />
            Evento recebido da Meta
          </p>
          {lastEvent.kind === "finish" && (
            <p className="text-muted-foreground">
              Onboarding concluído
              {lastEvent.coexistence ? " por coexistência" : ""} · WABA{" "}
              <span className="font-mono text-xs text-foreground">{lastEvent.wabaId ?? "—"}</span>
              {lastEvent.phoneNumberId && (
                <>
                  {" "}
                  · número{" "}
                  <span className="font-mono text-xs text-foreground">
                    {lastEvent.phoneNumberId}
                  </span>
                </>
              )}
              <span className="mt-1 block text-xs">Nada foi gravado — isso é a etapa 4C.</span>
            </p>
          )}
          {lastEvent.kind === "cancel" && (
            <p className="text-muted-foreground">
              Fluxo cancelado{lastEvent.step ? ` em ${lastEvent.step}` : ""}. É o esperado nesta
              etapa.
            </p>
          )}
          {lastEvent.kind === "error" && (
            <p className={cn("text-destructive")}>{lastEvent.message}</p>
          )}
        </div>
      )}
    </section>
  );
}
