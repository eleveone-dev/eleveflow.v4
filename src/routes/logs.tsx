import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import Logs from "@/pages/Logs";

export const Route = createFileRoute("/logs")({
  head: () => ({
    meta: [
      { title: "Logs — EleveFlow CRM" },
      {
        name: "description",
        content: "Visualize histórico de envios, eventos e execuções de fluxos no EleveFlow CRM.",
      },
      { property: "og:title", content: "Logs — EleveFlow CRM" },
      {
        property: "og:description",
        content: "Visualize histórico de envios, eventos e execuções de fluxos no EleveFlow CRM.",
      },
      { property: "og:url", content: "https://happy-thread-weaver.lovable.app/logs" },
    ],
    links: [{ rel: "canonical", href: "https://happy-thread-weaver.lovable.app/logs" }],
  }),
  component: () => (
    <AppLayout>
      <Logs />
    </AppLayout>
  ),
});
