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
import { useNavigate, createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { useState } from "react";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Redefinir Senha — EleveFlow CRM" },
      { name: "description", content: "Defina uma nova senha para sua conta EleveFlow CRM." },
      { property: "og:title", content: "Redefinir Senha — EleveFlow CRM" },
      {
        property: "og:description",
        content: "Defina uma nova senha para sua conta EleveFlow CRM.",
      },
      { property: "og:url", content: "https://eleveflow.eleveone.com.br/reset-password" },
    ],
    links: [{ rel: "canonical", href: "https://eleveflow.eleveone.com.br/reset-password" }],
  }),
  component: ResetPassword,
});

const schema = z
  .object({
    password: z.string().min(6, "A senha deve ter pelo menos 6 caracteres"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "As senhas não coincidem",
    path: ["confirmPassword"],
  });

export default function ResetPassword() {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const onSubmit = async (values: z.infer<typeof schema>) => {
    setLoading(true);
    const { error } = await supabase.auth.updateUser({
      password: values.password,
    });

    setLoading(false);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Senha alterada com sucesso!");
      navigate({ to: "/dashboard" });
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0f0f0f] text-[#f1f5f9]">
      <div className="w-full max-w-sm rounded-lg bg-[#1a1a1a] p-8 border border-[#2a2a2a]">
        <h1 className="text-2xl font-bold mb-6 text-center text-[#6366f1]">Nova Senha</h1>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              name="password"
              control={form.control}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nova Senha</FormLabel>
                  <FormControl>
                    <Input type="password" {...field} className="bg-[#0f0f0f] border-[#2a2a2a]" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              name="confirmPassword"
              control={form.control}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Confirmar Senha</FormLabel>
                  <FormControl>
                    <Input type="password" {...field} className="bg-[#0f0f0f] border-[#2a2a2a]" />
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
              {loading ? "Alterando..." : "Alterar Senha"}
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}
