import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";

const Leads = lazy(() => import("@/pages/Leads"));

export const Route = createFileRoute("/leads")({
  head: () => ({
    meta: [
      { title: "Leads — EleveFlow CRM" },
      {
        name: "description",
        content: "Gerencie e acompanhe todos os seus leads em um único lugar com o EleveFlow CRM.",
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
        <Leads />
      </Suspense>
    </AppLayout>
  ),
});
