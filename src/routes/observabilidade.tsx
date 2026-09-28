import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import Observabilidade from "@/pages/Observabilidade";
import { useIsSuperadmin } from "@/hooks/useIsSuperadmin";

/** Painel de administração da plataforma, não ferramenta de cliente. Esconder do
 *  menu não basta: a rota responde a quem digita a URL. A guarda aqui é
 *  cosmética — os dados já são limitados ao tenant pela RLS —, mas evita expor
 *  uma tela de operação interna. */
function ObservabilidadeRestrita() {
  const isSuperadmin = useIsSuperadmin();

  if (isSuperadmin === undefined) return null;

  if (!isSuperadmin) {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <h1 className="text-xl font-semibold">Painel restrito</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A observabilidade é um painel de administração da plataforma. Se você precisa de algo
          daqui, fale com o administrador.
        </p>
      </div>
    );
  }

  return <Observabilidade />;
}

export const Route = createFileRoute("/observabilidade")({
  head: () => ({
    meta: [
      { title: "Observabilidade — EleveFlow CRM" },
      {
        name: "description",
        content: "Custos de IA, conversas do agente e saúde dos envios WhatsApp.",
      },
    ],
  }),
  component: () => (
    <AppLayout>
      <ObservabilidadeRestrita />
    </AppLayout>
  ),
});
