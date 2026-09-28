import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const Whatsapp = lazy(() => import("@/pages/Whatsapp"));

export const Route = createFileRoute("/whatsapp")({
  head: () => ({
    meta: [
      { title: "WhatsApp — EleveFlow CRM" },
      {
        name: "description",
        content:
          "Conecte sua conta de WhatsApp e gerencie conversas automatizadas no EleveFlow CRM.",
      },
    ],
  }),
  component: () => (
    <AppLayout>
      <Suspense
        fallback={
          <div className="flex flex-col items-center justify-center py-20 space-y-4 text-[#64748b]">
            <Loader2 className="h-8 w-8 animate-spin text-[#7c3aed]" />
            <p>Carregando módulo de WhatsApp...</p>
          </div>
        }
      >
        <Whatsapp />
      </Suspense>
    </AppLayout>
  ),
  errorComponent: () => (
    <div className="p-8">
      <ErrorBoundary>
        <div />
      </ErrorBoundary>
    </div>
  ),
});
