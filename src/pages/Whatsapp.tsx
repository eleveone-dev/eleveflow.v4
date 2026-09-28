// A tela do WhatsApp ramifica por provedor em vez de trocar de caminho.
//
// Decisão de 2026-09-18: a Evolution é o provedor ativo, e é o que uma conta
// nova vê. Conta que já tem linha `meta_cloud` continua na Cloud API — migrar
// de provedor é cutover por tenant, não um botão de tela. Por isso a troca só é
// oferecida para quem ainda não está na Meta.

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { EvolutionPanel } from "@/components/whatsapp/EvolutionPanel";
import { MetaPanel } from "@/components/whatsapp/MetaPanel";
import { useWhatsappProvider } from "@/hooks/use-evolution-connection";

function WhatsappContent() {
  const { data: provider, isLoading, error, refetch } = useWhatsappProvider();
  const [verMeta, setVerMeta] = useState(false);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-8 py-2">
        <Skeleton className="h-9 w-80" />
        <div className="space-y-6 pt-4">
          {[0, 1, 2].map((i) => (
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

  // Sem saber qual é o provedor, a tela não escolhe um: mostrar o painel errado
  // é pior do que dizer que a leitura falhou.
  if (error) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
          <div className="space-y-1">
            <p className="font-medium">Não foi possível saber qual conexão esta conta usa</p>
            <p className="text-sm text-muted-foreground">{(error as Error).message}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
              Tentar de novo
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const naMeta = provider === "meta_cloud" || verMeta;

  return (
    <div className="mx-auto max-w-3xl space-y-10 py-2">
      {naMeta ? <MetaPanel /> : <EvolutionPanel />}

      {provider !== "meta_cloud" && (
        <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-dashed border-border p-6">
          <div className="min-w-0">
            <h2 className="text-sm font-medium">
              {verMeta ? "Conexão pela Evolution" : "Conexão oficial pela Cloud API"}
            </h2>
            <p className="mt-1 max-w-[60ch] text-sm text-muted-foreground">
              {verMeta
                ? "Voltar para o pareamento por QR, que é o caminho ativo desta conta."
                : "O caminho da Meta segue disponível, sem credencial gravada nesta conta."}
            </p>
          </div>
          <Button variant="outline" onClick={() => setVerMeta(!verMeta)} className="shrink-0">
            {verMeta ? "Ver a Evolution" : "Ver a Cloud API"}
          </Button>
        </section>
      )}
    </div>
  );
}

export default function Whatsapp() {
  return (
    <ErrorBoundary>
      <WhatsappContent />
    </ErrorBoundary>
  );
}
