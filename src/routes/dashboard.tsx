import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";

// Lazy loading do componente de página real
const Dashboard = lazy(() => import("@/pages/Dashboard"));

const DashboardSkeleton = () => (
  <div className="space-y-8">
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
      <Skeleton className="h-12 w-48" />
      <Skeleton className="h-16 w-full md:w-[280px] rounded-2xl" />
    </div>
    <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
      {[...Array(6)].map((_, i) => (
        <Skeleton key={i} className="h-32 w-full rounded-2xl" />
      ))}
    </div>
  </div>
);

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — EleveFlow CRM" },
      {
        name: "description",
        content:
          "Acompanhe métricas, leads ativos e desempenho de fluxos em tempo real no EleveFlow CRM.",
      },
    ],
  }),
  component: () => (
    <AppLayout>
      <Suspense fallback={<DashboardSkeleton />}>
        <Dashboard />
      </Suspense>
    </AppLayout>
  ),
});
