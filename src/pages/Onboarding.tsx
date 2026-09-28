import { useState, useEffect } from "react";
import { useAccount, useUpdateAccount, useStages } from "@/hooks/use-crm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  CheckCircle2,
  ChevronRight,
  Loader2,
  GitBranch,
  Smartphone,
  Rocket,
  RefreshCw,
  AlertTriangle,
  Settings,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { useWhatsappConnection } from "@/hooks/use-whatsapp-connection";

export default function OnboardingPage() {
  const { data: account, isLoading: accountLoading } = useAccount();
  const { data: stages, isLoading: stagesLoading } = useStages();
  const { data: connection, isLoading: connectionLoading } = useWhatsappConnection();
  const connectionVerified = connection?.checks.phoneNumber === "ok";
  const updateAccount = useUpdateAccount();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [companyName, setCompanyName] = useState("");

  useEffect(() => {
    if (account?.name) {
      setCompanyName(account.name);
    }
  }, [account]);

  // Auto-advance onboarding when connected
  useEffect(() => {
    if (step === 3 && connectionVerified) {
      setTimeout(() => {
        setStep(4);
      }, 1500);
    }
  }, [connectionVerified, step]);

  const handleNext = () => {
    if (step === 1 && !companyName) {
      toast.error("Por favor, informe seu nome ou da sua empresa.");
      return;
    }
    setStep((prev) => prev + 1);
  };

  const handleComplete = () => {
    updateAccount.mutate(
      {
        name: companyName,
        onboarding_completed: true,
      },
      {
        onSuccess: () => {
          toast.success("Bem-vindo ao EleveFlow!");
          navigate({ to: "/dashboard" });
        },
      },
    );
  };

  if (accountLoading || stagesLoading)
    return (
      <div className="flex h-screen items-center justify-center bg-[#0f0f0f] text-white">
        Carregando...
      </div>
    );

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0a0a0f] p-4 text-[#f1f5f9]">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex justify-center gap-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className={`h-1.5 w-12 rounded-full transition-colors ${i <= step ? "bg-[#7c3aed]" : "bg-[#2a2a3a]"}`}
            />
          ))}
        </div>

        {step === 1 && (
          <Card className="bg-[#111118] border-[#2a2a3a] text-white shadow-2xl rounded-2xl overflow-hidden">
            <CardHeader className="text-center">
              <div className="mx-auto mb-6 h-20 w-20 rounded-2xl bg-linear-to-br from-[#7c3aed] to-[#6d28d9] flex items-center justify-center shadow-xl shadow-[#7c3aed]/20 rotate-3 group-hover:rotate-0 transition-transform">
                <Rocket className="h-10 w-10 text-white" />
              </div>
              <CardTitle className="text-3xl">Bem-vindo ao EleveFlow!</CardTitle>
              <CardDescription className="text-[#64748b]">
                Vamos configurar sua conta em menos de 2 minutos.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-6">
              <div className="space-y-2">
                <Label htmlFor="company">
                  Como deseja ser chamado ou qual o nome da sua empresa?
                </Label>
                <Input
                  id="company"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Ex: Eleve Negócios"
                  className="bg-[#0f0f0f] border-[#2a2a2a] h-12 text-lg focus:ring-[#6366f1]"
                />
              </div>
            </CardContent>
            <CardFooter className="flex justify-end pt-6">
              <Button
                onClick={handleNext}
                className="bg-[#7c3aed] hover:bg-[#6d28d9] h-12 px-10 rounded-xl font-bold shadow-lg shadow-[#7c3aed]/20 transition-all active:scale-95"
              >
                Continuar <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </CardFooter>
          </Card>
        )}

        {step === 2 && (
          <Card className="bg-[#111118] border-[#2a2a3a] text-white shadow-2xl rounded-2xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GitBranch className="h-6 w-6 text-[#6366f1]" />
                Seu Pipeline de Vendas
              </CardTitle>
              <CardDescription className="text-[#64748b]">
                Estes são os estágios padrão que criamos para você. Você pode editá-los depois.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-6">
              <div className="grid gap-3">
                {stages?.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between p-4 rounded-xl bg-[#0d0d14] border border-[#2a2a3a] group hover:border-[#7c3aed]/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className="h-3 w-3 rounded-full"
                        style={{ backgroundColor: s.color || "#6366f1" }}
                      />
                      <span className="font-medium">{s.name}</span>
                    </div>
                    <Badge variant="outline" className="border-[#2a2a2a] text-[#64748b]">
                      Padronizado
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
            <CardFooter className="flex justify-between pt-6">
              <Button
                variant="ghost"
                onClick={() => setStep((prev) => prev - 1)}
                className="text-[#94a3b8] hover:text-white hover:bg-[#1e293b]"
              >
                Voltar
              </Button>
              <Button
                onClick={handleNext}
                className="bg-[#7c3aed] hover:bg-[#6d28d9] h-12 px-10 rounded-xl font-bold shadow-lg shadow-[#7c3aed]/20 transition-all active:scale-95 text-white"
              >
                Está ótimo! <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </CardFooter>
          </Card>
        )}

        {step === 3 && (
          <Card className="bg-[#111118] border-[#2a2a3a] text-white shadow-2xl rounded-2xl">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-green-500/10 flex items-center justify-center">
                <Smartphone className="h-8 w-8 text-green-500" />
              </div>
              <CardTitle>Conectar WhatsApp</CardTitle>
              <CardDescription className="text-[#64748b]">
                Conecte seu dispositivo para começar a automatizar suas mensagens.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center py-4">
              {connectionVerified ? (
                <div className="flex flex-col items-center space-y-4 py-8">
                  <div className="h-20 w-20 rounded-full bg-green-500/20 flex items-center justify-center">
                    <CheckCircle2 className="h-10 w-10 text-green-500" />
                  </div>
                  <div className="text-center">
                    <p className="font-bold text-lg">WhatsApp conectado</p>
                    <p className="text-sm text-[#64748b]">
                      {connection?.phoneNumber?.displayPhoneNumber ?? "Número oficial ativo"}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="py-8 flex flex-col items-center space-y-5 text-center">
                  <div className="h-20 w-20 rounded-full bg-[#7c3aed]/10 flex items-center justify-center">
                    <Smartphone className="h-9 w-9 text-[#7c3aed]" />
                  </div>
                  <div className="max-w-sm space-y-2">
                    <p className="font-medium">Nenhum número conectado ainda</p>
                    <p className="text-sm text-[#64748b]">
                      A conexão com o WhatsApp oficial é feita por um administrador da plataforma,
                      com as credenciais do app da Meta. Siga em frente: você pode montar seus
                      fluxos agora e ativá-los quando o número estiver no ar.
                    </p>
                  </div>
                </div>
              )}

              <p className="text-xs text-[#64748b] text-center mt-6">
                Você pode pular este passo agora e conectar depois nas configurações.
              </p>
            </CardContent>
            <CardFooter className="flex justify-between pt-6">
              <Button
                variant="ghost"
                onClick={() => setStep((prev) => prev - 1)}
                className="text-[#475569] hover:text-white"
              >
                Voltar
              </Button>
              <Button
                variant="outline"
                onClick={handleNext}
                className="border-[#2a2a3a] text-[#94a3b8] hover:text-white hover:border-[#7c3aed]"
              >
                {connectionVerified ? "Continuar" : "Pular por agora"}
              </Button>
            </CardFooter>
          </Card>
        )}

        {step === 4 && (
          <Card className="bg-[#111118] border-[#2a2a2a] text-white shadow-2xl rounded-2xl">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-purple-500/10 flex items-center justify-center">
                <GitBranch className="h-8 w-8 text-purple-500" />
              </div>
              <CardTitle>Seu Primeiro Fluxo</CardTitle>
              <CardDescription className="text-[#64748b]">
                Deseja criar sua primeira sequência automática agora?
              </CardDescription>
            </CardHeader>
            <CardContent className="py-8 text-center">
              <p className="text-[#64748b]">
                A maioria dos usuários começa com um fluxo de "Boas Vindas".
              </p>
            </CardContent>
            <CardFooter className="flex justify-between pt-6">
              <Button
                variant="ghost"
                onClick={() => setStep((prev) => prev - 1)}
                className="text-[#475569] hover:text-white"
              >
                Voltar
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={handleNext}
                  className="border-[#2a2a3a] text-[#94a3b8] hover:text-white hover:border-[#7c3aed]"
                >
                  Pular por agora
                </Button>
                <Button
                  onClick={() => navigate({ to: "/flows" as any })}
                  className="bg-[#7c3aed] hover:bg-[#6d28d9] rounded-xl font-bold shadow-lg shadow-[#7c3aed]/20 transition-all active:scale-95"
                >
                  Criar Fluxo
                </Button>
              </div>
            </CardFooter>
          </Card>
        )}

        {step === 5 && (
          <Card className="bg-[#111118] border-[#2a2a3a] text-white shadow-2xl rounded-2xl overflow-hidden">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 h-20 w-20 rounded-full bg-[#6366f1]/20 flex items-center justify-center">
                <CheckCircle2 className="h-10 w-10 text-[#6366f1]" />
              </div>
              <CardTitle className="text-3xl">Tudo Pronto!</CardTitle>
              <CardDescription className="text-[#64748b]">
                Sua conta foi configurada com sucesso. Vamos começar a vender?
              </CardDescription>
            </CardHeader>
            <CardContent className="py-8 space-y-4">
              <div className="p-4 rounded-lg bg-[#6366f1]/5 border border-[#6366f1]/10 flex items-start gap-3">
                <div className="h-5 w-5 mt-0.5 rounded bg-[#6366f1] flex items-center justify-center text-[10px] font-bold">
                  1
                </div>
                <div>
                  <p className="text-sm font-medium">Dica:</p>
                  <p className="text-xs text-[#64748b]">
                    Use o <strong>Extrator</strong> para encontrar leads qualificados no Google Maps
                    rapidamente.
                  </p>
                </div>
              </div>
            </CardContent>
            <CardFooter className="pt-6">
              <Button
                onClick={handleComplete}
                className="w-full bg-linear-to-br from-[#7c3aed] to-[#3b82f6] hover:brightness-110 h-14 rounded-xl text-lg font-bold shadow-xl shadow-[#7c3aed]/20 transition-all active:scale-95"
              >
                Começar agora!
              </Button>
            </CardFooter>
          </Card>
        )}
      </div>
    </div>
  );
}
