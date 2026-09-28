import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { supabase, isSupabaseConfigured } from "@/integrations/supabase/client";
import { initializeDefaultStages } from "@/lib/pipeline";
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

export const Route = createFileRoute("/register")({
  head: () => ({
    meta: [
      { title: "Criar Conta — EleveFlow CRM" },
      {
        name: "description",
        content: "Crie sua conta gratuita no EleveFlow CRM e automatize seu WhatsApp em minutos.",
      },
      { property: "og:title", content: "Criar Conta — EleveFlow CRM" },
      {
        property: "og:description",
        content: "Crie sua conta gratuita no EleveFlow CRM e automatize seu WhatsApp em minutos.",
      },
      { property: "og:url", content: "https://happy-thread-weaver.lovable.app/register" },
    ],
    links: [{ rel: "canonical", href: "https://happy-thread-weaver.lovable.app/register" }],
  }),
  component: Register,
});

const schema = z.object({
  email: z.string().email("Email inválido").min(1, "Email é obrigatório"),
  password: z.string().min(6, "A senha deve ter pelo menos 6 caracteres"),
  name: z.string().min(2, "O nome deve ter pelo menos 2 caracteres"),
});

export default function Register() {
  const navigate = useNavigate();
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "", name: "" },
  });

  const onSubmit = async (values: z.infer<typeof schema>) => {
    // Log presence status for debugging
    console.log("[Cadastro] Clique no botão cadastrar detectado");
    console.log(`[Cadastro] isSupabaseConfigured: ${isSupabaseConfigured}`);

    if (!isSupabaseConfigured) {
      toast.error("Erro de configuração: Supabase não detectado no ambiente.");
      return;
    }

    const { data, error } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
    });

    if (error) {
      console.error("[Supabase Auth Error]", error);
      toast.error(error.message);
      return;
    }

    if (data.user) {
      try {
        const { error: accError } = await supabase.from("accounts").insert({
          user_id: data.user.id,
          name: values.name,
        });

        // Initialize default stages
        await initializeDefaultStages(data.user.id);

        if (accError) {
          console.error("[DB Error] Erro ao criar conta:", accError);
          toast.warning("Usuário criado, mas houve um erro ao configurar o perfil.");
        } else {
          toast.success("Conta criada com sucesso!");
        }
      } catch (err) {
        console.error("[Unexpected Error]", err);
      }

      navigate({ to: "/dashboard" as any });
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0f0f0f] text-[#f1f5f9]">
      <div className="w-full max-w-sm rounded-lg bg-[#1a1a1a] p-8 border border-[#2a2a2a]">
        <h1 className="text-2xl font-bold mb-6 text-center text-[#6366f1]">EleveFlow</h1>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              name="name"
              control={form.control}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nome</FormLabel>
                  <FormControl>
                    <Input {...field} className="bg-[#0f0f0f] border-[#2a2a2a]" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
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
            <Button type="submit" className="w-full bg-[#6366f1] hover:bg-[#6366f1]/90">
              Cadastrar
            </Button>
            <div className="text-center text-sm text-[#64748b]">
              Já tem uma conta?{" "}
              <Link to="/login" className="text-[#6366f1] hover:underline">
                Entre aqui
              </Link>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
