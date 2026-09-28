import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import Extractor from "@/pages/Extractor";

export const Route = createFileRoute("/extractor")({
  head: () => ({
    meta: [
      { title: "Extrator de Leads — EleveFlow CRM" },
      {
        name: "description",
        content:
          "Extraia contatos qualificados e importe diretamente para sua pipeline no EleveFlow CRM.",
      },
      { property: "og:title", content: "Extrator de Leads — EleveFlow CRM" },
      {
        property: "og:description",
        content:
          "Extraia contatos qualificados e importe diretamente para sua pipeline no EleveFlow CRM.",
      },
      { property: "og:url", content: "https://happy-thread-weaver.lovable.app/extractor" },
    ],
    links: [{ rel: "canonical", href: "https://happy-thread-weaver.lovable.app/extractor" }],
  }),
  component: () => (
    <AppLayout>
      <Extractor />
    </AppLayout>
  ),
});
