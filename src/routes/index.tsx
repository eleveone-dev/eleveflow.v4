import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "EleveFlow CRM — Automação de WhatsApp e Pipeline de Vendas" },
      {
        name: "description",
        content:
          "EleveFlow CRM: automatize seu WhatsApp, gerencie leads em pipeline visual e crie fluxos personalizados para escalar suas vendas.",
      },
      {
        property: "og:title",
        content: "EleveFlow CRM — Automação de WhatsApp e Pipeline de Vendas",
      },
      {
        property: "og:description",
        content:
          "Automatize seu WhatsApp, gerencie leads em pipeline visual e crie fluxos personalizados para escalar suas vendas.",
      },
      { property: "og:url", content: "https://happy-thread-weaver.lovable.app/" },
    ],
    links: [{ rel: "canonical", href: "https://happy-thread-weaver.lovable.app/" }],
  }),
  component: Index,
});

// IMPORTANT: Replace this placeholder. See ./README.md for routing conventions.
function Index() {
  const navigate = useNavigate();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate({ to: "/dashboard" });
      } else {
        navigate({ to: "/login" });
      }
    });
  }, []);

  return (
    <div className="flex h-screen items-center justify-center bg-[#0f0f0f] text-white">
      <Loader2 className="h-8 w-8 animate-spin text-[#6366f1]" />
    </div>
  );
}
