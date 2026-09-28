import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { supabase } from "@/integrations/supabase/client";
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
import { useState } from "react";

export const Route = createFileRoute("/forgot-password")({
  head: () => ({
    meta: [
      { title: "Recuperar Senha — EleveFlow CRM" },
      { name: "description", content: "Recupere o acesso à sua conta EleveFlow CRM por e-mail." },
      { property: "og:title", content: "Recuperar Senha — EleveFlow CRM" },
      {
        property: "og:description",
        content: "Recupere o acesso à sua conta EleveFlow CRM por e-mail.",
      },
      { property: "og:url", content: "https://happy-thread-weaver.lovable.app/forgot-password" },
    ],
    links: [{ rel: "canonical", href: "https://happy-thread-weaver.lovable.app/forgot-password" }],
  }),
  component: ForgotPassword,
});

const schema = z.object({
  email: z.string().email("Email inválido"),
});

export default function ForgotPassword() {
  const [loading, setLoading] = useState(false);
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
  });

  const onSubmit = async (values: z.infer<typeof schema>) => {
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(values.email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    setLoading(false);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Email de recuperação enviado!");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0f0f0f] text-[#f1f5f9]">
      <div className="w-full max-w-sm rounded-lg bg-[#1a1a1a] p-8 border border-[#2a2a2a]">
        <h1 className="text-2xl font-bold mb-2 text-center text-[#6366f1]">Recuperar Senha</h1>
        <p className="text-sm text-[#64748b] mb-6 text-center">
          Enviaremos um link para o seu email.
        </p>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              name="email"
              control={form.control}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="seu@email.com"
                      className="bg-[#0f0f0f] border-[#2a2a2a]"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              disabled={loading}
              className="w-full bg-[#6366f1] hover:bg-[#6366f1]/90"
            >
              {loading ? "Enviando..." : "Enviar Link"}
            </Button>
            <div className="text-center text-sm text-[#64748b]">
              Lembrou a senha?{" "}
              <Link to="/login" className="text-[#6366f1] hover:underline">
                Entrar
              </Link>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
