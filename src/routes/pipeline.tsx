import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";

const Pipeline = lazy(() => import("@/pages/Pipeline"));

export const Route = createFileRoute("/pipeline")({
  head: () => ({
    meta: [
      { title: "Pipeline — EleveFlow CRM" },
      {
        name: "description",
        content:
          "Visualize e organize sua pipeline de vendas com kanban personalizável no EleveFlow CRM.",
      },
    ],
  }),
  component: () => (
    <AppLayout>
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-[#7c3aed]" />
          </div>
        }
      >
        <Pipeline />
      </Suspense>
    </AppLayout>
  ),
});
