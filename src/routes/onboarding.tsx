import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import Onboarding from "@/pages/Onboarding";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [
      { title: "Bem-vindo — EleveFlow CRM" },
      {
        name: "description",
        content:
          "Configure sua conta EleveFlow CRM em poucos passos: pipeline, WhatsApp e primeiro fluxo.",
      },
      { property: "og:title", content: "Bem-vindo — EleveFlow CRM" },
      {
        property: "og:description",
        content:
          "Configure sua conta EleveFlow CRM em poucos passos: pipeline, WhatsApp e primeiro fluxo.",
      },
      { property: "og:url", content: "https://happy-thread-weaver.lovable.app/onboarding" },
    ],
    links: [{ rel: "canonical", href: "https://happy-thread-weaver.lovable.app/onboarding" }],
  }),
  component: () => (
    <AppLayout>
      <Onboarding />
    </AppLayout>
  ),
});
