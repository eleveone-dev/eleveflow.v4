import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import { lazy, Suspense } from "react";
import { z } from "zod";
import { Loader2 } from "lucide-react";

const Flows = lazy(() => import("@/pages/Flows"));

const flowsSearchSchema = z.object({
  tab: z.string().optional(),
});

export const Route = createFileRoute("/flows")({
  validateSearch: flowsSearchSchema,
  head: () => ({
    meta: [
      { title: "Fluxos — EleveFlow CRM" },
      {
        name: "description",
        content:
          "Crie e gerencie fluxos automatizados de WhatsApp para qualificar leads no EleveFlow CRM.",
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
        <Flows />
      </Suspense>
    </AppLayout>
  ),
});
