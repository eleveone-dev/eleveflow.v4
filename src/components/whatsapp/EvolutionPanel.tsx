import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Smartphone, TriangleAlert, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectionChain } from "@/components/whatsapp/ConnectionChain";
import {
  useEvolutionConnect,
  useEvolutionConnection,
  useEvolutionDisconnect,
} from "@/hooks/use-evolution-connection";
import { evolutionHeadline, evolutionLinks } from "@/lib/evolution-connection-view";
import { cn } from "@/lib/utils";

/** O QR da Baileys vence rapido. Em vez de recarregar sozinho e brigar com quem
 *  esta com o celular na mao, a tela conta o tempo e deixa a pessoa pedir outro. */
const VALIDADE_QR_SEGUNDOS = 45;

function QrCode({ imagem, onExpirar }: { imagem: string; onExpirar: () => void }) {
  const [restante, setRestante] = useState(VALIDADE_QR_SEGUNDOS);

  useEffect(() => {
    setRestante(VALIDADE_QR_SEGUNDOS);
    const id = window.setInterval(() => {
      setRestante((s) => {
        if (s <= 1) {
          window.clearInterval(id);
          onExpirar();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [imagem, onExpirar]);

  const fonte = imagem.startsWith("data:") ? imagem : `data:image/png;base64,${imagem}`;

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className={cn("rounded-xl bg-white p-3 transition-opacity", restante === 0 && "opacity-30")}
      >
        <img src={fonte} alt="Código para parear o WhatsApp" className="h-56 w-56" />
      </div>
      <p className="text-sm text-muted-foreground">
        {restante > 0
          ? `Este código vale por mais ${restante}s`
          : "Este código venceu. Gere outro para continuar."}
      </p>
    </div>
  );
}

export function EvolutionPanel() {
  const { data: state, isLoading, isFetching, refetch } = useEvolutionConnection();
  const conectar = useEvolutionConnect();
  const desconectar = useEvolutionDisconnect();
  const [qr, setQr] = useState<string | null>(null);

  if (isLoading || !state) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const verdict = evolutionHeadline(state);
  const links = evolutionLinks(state);

  const gerarCodigo = () => {
    conectar.mutate(undefined, {
      onSuccess: (r) => setQr(r.connected ? null : r.qrcode),
    });
  };

  return (
    <div className="space-y-10">
      <header className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
              WhatsApp · Evolution API
            </p>
            <h1 className={cn("text-3xl font-semibold tracking-tight sm:text-4xl", verdict.tone)}>
              {verdict.line}
            </h1>
            <p className="text-sm text-muted-foreground">
              Conferido em {new Date(state.checkedAt).toLocaleString("pt-BR")}
            </p>
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

        {state.error && (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <span>{state.error.message}</span>
          </p>
        )}
      </header>

      <section aria-labelledby="chain-heading" className="space-y-5">
        <h2 id="chain-heading" className="text-sm font-medium text-muted-foreground">
          Cada item mostra de onde veio a informação
        </h2>
        <ConnectionChain links={links} />
      </section>

      {!state.connected && (
        <section
          aria-labelledby="pair-heading"
          className="space-y-6 rounded-xl border border-border bg-card p-6"
        >
          <div className="space-y-1">
            <h2 id="pair-heading" className="text-sm font-medium">
              Parear um aparelho
            </h2>
            <p className="max-w-[60ch] text-sm text-muted-foreground">
              No celular, abra o WhatsApp, vá em Aparelhos conectados e escolha conectar um
              aparelho. Aponte a câmera para o código abaixo.
            </p>
          </div>

          {qr ? (
            <QrCode imagem={qr} onExpirar={() => setQr(null)} />
          ) : (
            <Button onClick={gerarCodigo} disabled={conectar.isPending}>
              {conectar.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Smartphone className="mr-2 h-4 w-4" aria-hidden />
              )}
              Gerar código
            </Button>
          )}

          {conectar.isError && <p className="text-sm text-destructive">{conectar.error.message}</p>}
          {conectar.isSuccess && conectar.data?.webhook.ok === false && (
            <p className="text-sm text-[#fbbf24]">
              O aparelho pode parear, mas o webhook não foi registrado
              {conectar.data.webhook.reason === "no_secret_configured"
                ? ": falta configurar o segredo do webhook no servidor"
                : "."}{" "}
              Sem ele, mensagens recebidas não chegam ao CRM.
            </p>
          )}
        </section>
      )}

      {state.connected && (
        <section className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-6">
          <div className="space-y-1">
            <p className="text-sm font-medium">Desconectar este número</p>
            <p className="max-w-[60ch] text-sm text-muted-foreground">
              O aparelho sai da sessão e nenhuma mensagem é enviada ou recebida até parear de novo.
              Os leads e o histórico continuam onde estão.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => desconectar.mutate()}
            disabled={desconectar.isPending}
            className="shrink-0"
          >
            {desconectar.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Unplug className="mr-2 h-4 w-4" aria-hidden />
            )}
            Desconectar
          </Button>
        </section>
      )}
    </div>
  );
}
