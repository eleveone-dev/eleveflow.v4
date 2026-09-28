import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import Queue from "@/pages/Queue";

export const Route = createFileRoute("/queue")({
  head: () => ({
    meta: [
      { title: "Fila de Envios — EleveFlow CRM" },
      {
        name: "description",
        content: "Acompanhe mensagens em fila e status de processamento no EleveFlow CRM.",
      },
      { property: "og:title", content: "Fila de Envios — EleveFlow CRM" },
      {
        property: "og:description",
        content: "Acompanhe mensagens em fila e status de processamento no EleveFlow CRM.",
      },
      { property: "og:url", content: "https://happy-thread-weaver.lovable.app/queue" },
    ],
    links: [{ rel: "canonical", href: "https://happy-thread-weaver.lovable.app/queue" }],
  }),
  component: () => (
    <AppLayout>
      <Queue />
    </AppLayout>
  ),
});
