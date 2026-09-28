import { z } from "zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { supabase, isSupabaseConfigured } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useNavigate, createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Entrar — EleveFlow CRM" },
      {
        name: "description",
        content:
          "Acesse sua conta EleveFlow CRM para gerenciar leads, fluxos e automações de WhatsApp.",
      },
      { property: "og:title", content: "Entrar — EleveFlow CRM" },
      {
        property: "og:description",
        content:
          "Acesse sua conta EleveFlow CRM para gerenciar leads, fluxos e automações de WhatsApp.",
      },
      { property: "og:url", content: "https://happy-thread-weaver.lovable.app/login" },
    ],
    links: [{ rel: "canonical", href: "https://happy-thread-weaver.lovable.app/login" }],
  }),
  component: Login,
});

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export default function Login() {
  const navigate = useNavigate();
  // Submit só depois da hidratação: sem isso o form dispara GET nativo
  // com as credenciais na URL antes do React assumir o onSubmit.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = async (values: z.infer<typeof schema>) => {
    if (!isSupabaseConfigured) {
      toast.error("Supabase não configurado. Verifique as variáveis de ambiente.");
      return;
    }

    console.log("[Login] Tentando entrar...");
    const { error } = await supabase.auth.signInWithPassword(values);
    if (error) {
      toast.error(error.message);
    } else {
      // Check onboarding status
      const { data: acc } = await supabase.from("accounts").select("onboarding_completed").single();
      if (acc && !acc.onboarding_completed) {
        navigate({ to: "/onboarding" as any });
      } else {
        navigate({ to: "/dashboard" as any });
      }
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0f0f0f] text-[#f1f5f9]">
      <div className="w-full max-w-sm rounded-lg bg-[#1a1a1a] p-8 border border-[#2a2a2a]">
        <h1 className="text-2xl font-bold mb-6 text-center text-[#6366f1]">EleveFlow</h1>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              name="email"
              control={form.control}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input {...field} className="bg-[#0f0f0f] border-[#2a2a2a]" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              name="password"
              control={form.control}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Senha</FormLabel>
                  <FormControl>
                    <Input type="password" {...field} className="bg-[#0f0f0f] border-[#2a2a2a]" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              disabled={!hydrated}
              className="w-full bg-[#6366f1] hover:bg-[#6366f1]/90"
            >
              Entrar
            </Button>
            <div className="text-center text-sm text-[#64748b]">
              Não tem uma conta?{" "}
              <Link to="/register" className="text-[#6366f1] hover:underline">
                Cadastre-se
              </Link>
            </div>
            <div className="text-center text-sm mt-2">
              <Link
                to="/forgot-password"
                title="Esqueci minha senha"
                className="text-[#64748b] hover:text-[#6366f1]"
              >
                Esqueci minha senha
              </Link>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
