import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const Modelos = lazy(() => import("@/pages/Modelos"));

export const Route = createFileRoute("/modelos")({
  head: () => ({
    meta: [
      { title: "Modelos de mensagem — EleveFlow CRM" },
      {
        name: "description",
        content: "Crie e acompanhe os modelos de mensagem aprovados pela Meta.",
      },
    ],
  }),
  component: () => (
    <AppLayout>
      <Suspense
        fallback={
          <div className="flex flex-col items-center justify-center space-y-4 py-20 text-[#64748b]">
            <Loader2 className="h-8 w-8 animate-spin text-[#7c3aed]" />
            <p>Carregando modelos...</p>
          </div>
        }
      >
        <ErrorBoundary>
          <Modelos />
        </ErrorBoundary>
      </Suspense>
    </AppLayout>
  ),
});
