import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const Conversas = lazy(() => import("@/pages/Conversas"));

export const Route = createFileRoute("/conversas")({
  head: () => ({
    meta: [
      { title: "Conversas — EleveFlow CRM" },
      {
        name: "description",
        content: "Converse com seus leads pelo WhatsApp oficial dentro do EleveFlow CRM.",
      },
    ],
  }),
  component: () => (
    <AppLayout>
      <Suspense
        fallback={
          <div className="flex flex-col items-center justify-center space-y-4 py-20 text-[#64748b]">
            <Loader2 className="h-8 w-8 animate-spin text-[#7c3aed]" />
            <p>Carregando conversas...</p>
          </div>
        }
      >
        <ErrorBoundary>
          <Conversas />
        </ErrorBoundary>
      </Suspense>
    </AppLayout>
  ),
});
