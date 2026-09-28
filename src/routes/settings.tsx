import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import Settings from "@/pages/Settings";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Configurações — EleveFlow CRM" },
      {
        name: "description",
        content: "Personalize sua conta, integrações e preferências no EleveFlow CRM.",
      },
      { property: "og:title", content: "Configurações — EleveFlow CRM" },
      {
        property: "og:description",
        content: "Personalize sua conta, integrações e preferências no EleveFlow CRM.",
      },
      { property: "og:url", content: "https://happy-thread-weaver.lovable.app/settings" },
    ],
    links: [{ rel: "canonical", href: "https://happy-thread-weaver.lovable.app/settings" }],
  }),
  component: () => (
    <AppLayout>
      <Settings />
    </AppLayout>
  ),
});
