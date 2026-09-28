import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";

const Diagnostics = lazy(() => import("@/pages/Diagnostics"));

export const Route = createFileRoute("/diagnostics")({
  component: () => (
    <AppLayout>
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-[#7c3aed]" />
          </div>
        }
      >
        <Diagnostics />
      </Suspense>
    </AppLayout>
  ),
});
