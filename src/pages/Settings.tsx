import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAccount, useUpdateAccount, useResetExecutions, useClearQueue } from "@/hooks/use-crm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { MetaIntegrationCard } from "@/components/settings/MetaIntegrationCard";
import { useIsSuperadmin } from "@/hooks/useIsSuperadmin";
import {
  Eye,
  EyeOff,
  Loader2,
  Trash2,
  Download,
  Power,
  Smartphone,
  ShieldAlert,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { getAccountSecrets, updateIntegrations } from "@/lib/account-secrets.functions";
import { safeText } from "@/lib/utils/safeData";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const downloadCSV = (data: any[], filename: string) => {
  if (data.length === 0) return;
  const headers = Object.keys(data[0]).join(",");
  const rows = data.map((obj) =>
    Object.values(obj)
      .map((val) => `"${String(val).replace(/"/g, '""')}"`)
      .join(","),
  );
  const csvContent = "data:text/csv;charset=utf-8," + headers + "\n" + rows.join("\n");
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `${filename}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

export default function SettingsPage() {
  const isSuperadmin = useIsSuperadmin();
  const { data: account, isLoading } = useAccount();
  const updateAccount = useUpdateAccount();
  const resetExecutions = useResetExecutions();
  const clearQueue = useClearQueue();
  const queryClient = useQueryClient();

  const { data: secrets } = useQuery({
    queryKey: ["account-secrets"],
    queryFn: () => getAccountSecrets(),
  });

  const saveIntegrationsMut = useMutation({
    mutationFn: (next: any) => updateIntegrations({ data: { integrations: next } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["account-secrets"] });
      toast.success("Integrações salvas!");
    },
    onError: (e: any) => toast.error(`Erro ao salvar: ${e.message}`),
  });

  const [integrations, setIntegrations] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (secrets) {
      setIntegrations(
        secrets.integrations || {
          serpapi: { key: "" },
        },
      );
    }
  }, [secrets]);

  useEffect(() => {
    if (account) {
      setSettings(
        account.settings || {
          send_interval_min_minutes: 4,
          send_interval_max_minutes: 7,
          start_hour: 8,
          end_hour: 18,
          days: [1, 2, 3, 4, 5],
          respect_business_hours: true,
          notifications: {
            whatsapp_disconnected: true,
            queue_stuck: true,
            lead_reply: true,
            send_errors: true,
          },
        },
      );
    }
  }, [account]);

  const handleSaveIntegrations = () => {
    saveIntegrationsMut.mutate(integrations);
  };

  const handleSaveSettings = () => {
    updateAccount.mutate({ settings });
  };

  const handleDeleteAccount = async () => {
    if (
      !window.confirm(
        "ATENÇÃO: Isso excluirá permanentemente sua conta e todos os dados relacionados (leads, mensagens, fluxos). Deseja continuar?",
      )
    ) {
      return;
    }

    setIsDeleting(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { error } = await supabase.from("accounts").delete().eq("user_id", user.id);
      if (error) throw error;

      await supabase.auth.signOut();
      window.location.href = "/login";
    } catch (e: any) {
      toast.error(`Erro ao excluir conta: ${e.message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  if (isLoading)
    return <div className="p-8 text-center text-[#64748b]">Carregando configurações...</div>;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">Configurações</h1>
        <p className="text-[#64748b]">Gerencie sua conta, integrações e preferências do sistema</p>
      </div>

      <Tabs defaultValue="perfil" className="w-full">
        <TabsList className="bg-[#0d0d14] p-1 border border-[#2a2a3a] w-full lg:w-auto justify-start overflow-x-auto overflow-y-hidden rounded-xl h-12 shadow-inner">
          <TabsTrigger
            value="perfil"
            className="data-[state=active]:bg-[#1a1a24] data-[state=active]:text-[#7c3aed] font-bold text-xs uppercase tracking-widest px-6 transition-all rounded-lg"
          >
            Perfil
          </TabsTrigger>
          <TabsTrigger
            value="whatsapp"
            className="data-[state=active]:bg-[#1a1a24] data-[state=active]:text-[#7c3aed] font-bold text-xs uppercase tracking-widest px-6 transition-all rounded-lg"
          >
            WhatsApp
          </TabsTrigger>
          <TabsTrigger
            value="integracoes"
            className="data-[state=active]:bg-[#1a1a24] data-[state=active]:text-[#7c3aed] font-bold text-xs uppercase tracking-widest px-6 transition-all rounded-lg"
          >
            Integrações
          </TabsTrigger>
          <TabsTrigger
            value="ferramentas"
            className="data-[state=active]:bg-[#1a1a24] data-[state=active]:text-[#7c3aed] font-bold text-xs uppercase tracking-widest px-6 transition-all rounded-lg"
          >
            Ferramentas
          </TabsTrigger>
          <TabsTrigger
            value="notificacoes"
            className="data-[state=active]:bg-[#1a1a24] data-[state=active]:text-[#7c3aed] font-bold text-xs uppercase tracking-widest px-6 transition-all rounded-lg"
          >
            Notificações
          </TabsTrigger>
          <TabsTrigger
            value="danger"
            className="data-[state=active]:bg-red-500/10 data-[state=active]:text-red-500 font-bold text-xs uppercase tracking-widest px-6 transition-all rounded-lg"
          >
            Danger Zone
          </TabsTrigger>
        </TabsList>

        <TabsContent value="perfil" className="space-y-4 mt-6">
          <Card className="bg-[#111118] border-[#2a2a3a] text-white shadow-2xl rounded-2xl overflow-hidden">
            <CardHeader>
              <CardTitle>Perfil do Usuário</CardTitle>
              <CardDescription className="text-[#64748b]">
                Atualize suas informações pessoais
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-6 pb-4">
                <div className="h-20 w-20 rounded-2xl bg-linear-to-br from-[#7c3aed] to-[#6d28d9] flex items-center justify-center text-2xl font-bold text-white shadow-xl shadow-[#7c3aed]/20">
                  {account?.name?.substring(0, 2).toUpperCase() || "EF"}
                </div>
                <Button
                  variant="outline"
                  className="border-[#2a2a2a]"
                  onClick={() => toast.info("Função temporariamente indisponível.")}
                >
                  Alterar Foto
                </Button>
              </div>
              <div className="space-y-2">
                <Label>Nome Completo</Label>
                <Input
                  value={account?.name || ""}
                  onChange={(e) => updateAccount.mutate({ name: e.target.value })}
                  className="bg-[#0d0d14] border-[#2a2a3a] h-12"
                />
              </div>
              <div className="space-y-2">
                <Label>Email (Somente leitura)</Label>
                <Input
                  value={account?.email || ""}
                  disabled
                  className="bg-[#0f0f0f] border-[#2a2a2a] opacity-50"
                />
              </div>
            </CardContent>
            <CardFooter className="border-t border-[#2a2a2a] pt-6">
              <Button
                onClick={() => {
                  try {
                    updateAccount.mutate({ name: account?.name || "" });
                  } catch (e) {
                    console.error(e);
                    toast.error("Não foi possível salvar.");
                  }
                }}
                disabled={updateAccount.isPending}
                className="bg-[#7c3aed] hover:bg-[#6d28d9] px-8 font-bold h-11"
              >
                Salvar Alterações
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="whatsapp" className="space-y-4 mt-6">
          <Card className="bg-[#111118] border-[#2a2a3a] text-white shadow-2xl rounded-2xl overflow-hidden">
            <CardHeader>
              <div className="flex justify-between items-center">
                <CardTitle>Status da Conexão</CardTitle>
                <Badge
                  className={
                    account?.whatsapp_status === "connected" ? "bg-green-500" : "bg-red-500"
                  }
                >
                  {account?.whatsapp_status === "connected" ? "Conectado" : "Desconectado"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="p-4 rounded-lg bg-[#0f0f0f] border border-[#2a2a2a] flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Smartphone className="h-5 w-5 text-[#7c3aed]" />
                  <div>
                    <p className="text-sm font-medium">
                      {account?.whatsapp_status === "connected"
                        ? "Número Conectado"
                        : "Nenhum número conectado"}
                    </p>
                    <p className="text-xs text-[#64748b]">
                      Acesse a aba WhatsApp para gerenciar a conexão
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    try {
                      window.location.href = "/whatsapp";
                    } catch (e) {
                      console.error(e);
                    }
                  }}
                  className="border-[#2a2a2a]"
                >
                  Gerenciar
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-[#111118] border-[#2a2a3a] text-white shadow-2xl rounded-2xl overflow-hidden">
            <CardHeader>
              <CardTitle>Configurações de Envio</CardTitle>
              <CardDescription className="text-[#64748b]">
                Configure os limites e horários para disparos automáticos
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Respeitar horário comercial</Label>
                  <p className="text-xs text-[#64748b]">
                    Pausa envios fora do horário e dias definidos abaixo
                  </p>
                </div>
                <Switch
                  checked={settings?.respect_business_hours}
                  onCheckedChange={(v) => setSettings({ ...settings, respect_business_hours: v })}
                />
              </div>

              <div className="space-y-4 pt-4 border-t border-[#2a2a3a]">
                <Label>Dias de envio</Label>
                <div className="flex flex-wrap gap-2">
                  {[
                    { id: 1, label: "Seg" },
                    { id: 2, label: "Ter" },
                    { id: 3, label: "Qua" },
                    { id: 4, label: "Qui" },
                    { id: 5, label: "Sex" },
                    { id: 6, label: "Sáb" },
                    { id: 0, label: "Dom" },
                  ].map((day) => (
                    <Button
                      key={day.id}
                      variant={settings?.days?.includes(day.id) ? "default" : "outline"}
                      size="sm"
                      onClick={() => {
                        const days = settings?.days || [];
                        const newDays = days.includes(day.id)
                          ? days.filter((d: number) => d !== day.id)
                          : [...days, day.id];
                        setSettings({ ...settings, days: newDays });
                      }}
                      className={
                        settings?.days?.includes(day.id) ? "bg-[#7c3aed]" : "border-[#2a2a3a]"
                      }
                    >
                      {day.label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label>Início dos envios (Hora)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    value={settings?.start_hour ?? 8}
                    onChange={(e) =>
                      setSettings({ ...settings, start_hour: parseInt(e.target.value) })
                    }
                    className="bg-[#0f0f0f] border-[#2a2a3a]"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Fim dos envios (Hora)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    value={settings?.end_hour ?? 18}
                    onChange={(e) =>
                      setSettings({ ...settings, end_hour: parseInt(e.target.value) })
                    }
                    className="bg-[#0f0f0f] border-[#2a2a3a]"
                  />
                </div>
                {/* O intervalo não é fixo: cada envio sorteia um tempo contínuo
                    entre mínimo e máximo, e de tempos em tempos entra uma pausa
                    longa. Intervalo fixo é o padrão mais fácil de o WhatsApp
                    reconhecer como disparo em série. */}
                <div className="space-y-2">
                  <Label>Intervalo mínimo entre envios (min)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={120}
                    value={
                      settings?.send_interval_min_minutes ?? settings?.send_interval_minutes ?? 4
                    }
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        send_interval_min_minutes: Math.max(1, parseInt(e.target.value) || 1),
                      })
                    }
                    className="bg-[#0f0f0f] border-[#2a2a3a]"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Intervalo máximo entre envios (min)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={240}
                    value={
                      settings?.send_interval_max_minutes ??
                      Math.round(
                        (settings?.send_interval_min_minutes ??
                          settings?.send_interval_minutes ??
                          4) * 1.8,
                      )
                    }
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        send_interval_max_minutes: Math.max(1, parseInt(e.target.value) || 1),
                      })
                    }
                    className="bg-[#0f0f0f] border-[#2a2a3a]"
                  />
                </div>
                <p className="text-xs text-[#64748b] md:col-span-2 -mt-3">
                  Cada envio sorteia um tempo entre o mínimo e o máximo — horários mistos, sem
                  padrão. A cada 8 a 15 envios entra uma pausa de 10 a 25 minutos, e o primeiro
                  envio do dia sai em até 20 minutos depois do início. Resposta de cliente sai na
                  hora, fora desse ritmo.
                </p>
                <div className="space-y-2 md:col-span-2">
                  <Label>Número de Teste WhatsApp</Label>
                  <Input
                    placeholder="(11) 99999-9999"
                    value={settings?.test_phone || ""}
                    onChange={(e) => setSettings({ ...settings, test_phone: e.target.value })}
                    className="bg-[#0f0f0f] border-[#2a2a3a]"
                  />
                  <p className="text-xs text-[#64748b]">
                    Usado para testar fluxos antes de enviar para clientes reais
                  </p>
                </div>
              </div>
            </CardContent>
            <CardFooter className="border-t border-[#2a2a2a] pt-6">
              <Button
                onClick={handleSaveSettings}
                className="bg-[#7c3aed] hover:bg-[#6d28d9] px-8 font-bold h-11"
              >
                Salvar Configurações
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="integracoes" className="space-y-4 mt-6">
          {/* A chave que o extrator usa de verdade é a global do projeto
              (`SERPAPI_KEY` nos secrets), não esta. Deixar o campo visível para o
              cliente sugeria que cada conta precisa da própria chave, e ainda
              expunha a chave de quem preencheu. Fica só para o superadmin. */}
          {isSuperadmin && (
            <Card className="bg-[#111118] border-[#2a2a3a] text-white shadow-2xl rounded-2xl overflow-hidden">
              <CardHeader>
                <CardTitle>SerpAPI (Google Maps Extrator)</CardTitle>
                <CardDescription className="text-[#64748b]">
                  Utilizada para buscar empresas e extrair contatos
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <Label>API Key</Label>
                    <a
                      href="https://serpapi.com/"
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-[#7c3aed] hover:underline"
                    >
                      Obter minha API Key
                    </a>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type={showKeys ? "text" : "password"}
                      value={integrations?.serpapi?.key || ""}
                      onChange={(e) =>
                        setIntegrations({
                          ...integrations,
                          serpapi: { ...integrations.serpapi, key: e.target.value },
                        })
                      }
                      className="bg-[#0f0f0f] border-[#2a2a2a]"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setShowKeys(!showKeys)}
                      className="text-[#64748b]"
                    >
                      {showKeys ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              </CardContent>
              <CardFooter>
                <Button
                  onClick={handleSaveIntegrations}
                  className="bg-[#7c3aed] hover:bg-[#6d28d9] px-8 font-bold h-11"
                >
                  Salvar SerpAPI
                </Button>
              </CardFooter>
            </Card>
          )}

          <MetaIntegrationCard />
        </TabsContent>

        <TabsContent value="ferramentas" className="space-y-4 mt-6">
          <Card className="bg-[#111118] border-[#2a2a3a] text-white shadow-2xl rounded-2xl overflow-hidden">
            <CardHeader>
              <CardTitle>Ferramentas de Manutenção</CardTitle>
              <CardDescription className="text-[#64748b]">
                Ações especiais para correção de dados no sistema
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-[#0d0d14] border border-[#2a2a3a] rounded-xl">
                <div>
                  <h4 className="font-bold text-sm">Corrigir origem dos leads</h4>
                  <p className="text-xs text-[#64748b] mt-1">
                    Identifica leads sem origem que vieram do Extrator Google e atribui a etiqueta
                    correta.
                  </p>
                </div>
                <Button
                  onClick={async () => {
                    if (
                      !window.confirm("Executar correção de origem para todos os leads sem fonte?")
                    )
                      return;
                    try {
                      const {
                        data: { user },
                      } = await supabase.auth.getUser();
                      if (!user) {
                        toast.error("Usuário não autenticado.");
                        return;
                      }

                      const { data: stages } = await supabase
                        .from("pipeline_stages")
                        .select("id")
                        .eq("user_id", user.id)
                        .eq("name", "Prospecção");

                      const stageIds = stages?.map((s) => s.id) || [];
                      if (stageIds.length === 0) {
                        toast.info("Nenhuma etapa de Prospecção encontrada.");
                        return;
                      }

                      const { data: updatedLeads, error } = await supabase
                        .from("leads")
                        .update({ source: "extrator-google" })
                        .eq("user_id", user.id)
                        .or('source.is.null,source.eq.""')
                        .or(
                          `stage_id.in.(${stageIds.join(",")}),address.not.is.null,website.not.is.null,category.not.is.null`,
                        )
                        .select();

                      if (error) throw error;

                      toast.success(`Origem corrigida em ${updatedLeads?.length || 0} leads`);
                      queryClient.invalidateQueries({ queryKey: ["leads"] });
                    } catch (e: any) {
                      console.error("[Settings] correção falhou:", e);
                      toast.error(`Erro na correção: ${e?.message || "falha desconhecida"}`);
                    }
                  }}
                  variant="outline"
                  className="border-[#2a2a3a] hover:bg-[#1a1a24] font-bold text-xs uppercase"
                >
                  Executar Correção
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notificacoes" className="space-y-4 mt-6">
          <Card className="bg-[#111118] border-[#2a2a3a] text-white shadow-2xl rounded-2xl overflow-hidden">
            <CardHeader>
              <CardTitle>Preferências de Notificação</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {[
                { key: "whatsapp_disconnected", label: "WhatsApp desconectado" },
                { key: "queue_stuck", label: "Fila de envio travada" },
                { key: "lead_reply", label: "Lead respondeu a uma mensagem" },
                { key: "send_errors", label: "Erros de envio detectados" },
              ].map((notif) => (
                <div key={notif.key} className="flex items-center justify-between">
                  <Label>{notif.label}</Label>
                  <Switch
                    checked={settings?.notifications?.[notif.key]}
                    onCheckedChange={(v) =>
                      setSettings({
                        ...settings,
                        notifications: { ...settings.notifications, [notif.key]: v },
                      })
                    }
                  />
                </div>
              ))}
              <div className="pt-4 space-y-2">
                <Label>Email para notificações</Label>
                <Input
                  value={account?.email || ""}
                  disabled
                  className="bg-[#0f0f0f] border-[#2a2a3a] opacity-50"
                />
              </div>
            </CardContent>
            <CardFooter className="border-t border-[#2a2a2a] pt-6">
              <Button
                onClick={handleSaveSettings}
                className="bg-[#7c3aed] hover:bg-[#6d28d9] px-8 font-bold h-11"
              >
                Salvar Notificações
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="danger" className="space-y-4 mt-6">
          <Card className="bg-[#111118] border-red-500/20 text-white shadow-2xl rounded-2xl overflow-hidden">
            <CardHeader>
              <CardTitle className="text-red-500 flex items-center gap-2">
                <ShieldAlert className="h-5 w-5" />
                Zona de Perigo
              </CardTitle>
              <CardDescription className="text-[#64748b]">
                Ações irreversíveis que afetam seus dados
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg bg-red-500/5 border border-red-500/10">
                <div>
                  <p className="text-sm font-medium">Limpar Fila de Envio</p>
                  <p className="text-xs text-[#64748b]">
                    Deleta todas as mensagens pendentes para este usuário
                  </p>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    if (confirm("Deseja realmente limpar a fila de envio?")) clearQueue.mutate();
                  }}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Limpar Fila
                </Button>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg bg-orange-500/5 border border-orange-500/10">
                <div>
                  <p className="text-sm font-medium">Resetar Execuções Ativas</p>
                  <p className="text-xs text-[#64748b]">
                    Pausa todos os fluxos em execução no momento
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (confirm("Pausar todas as execuções de fluxo?")) resetExecutions.mutate();
                  }}
                  className="border-orange-500/20 text-orange-500 hover:bg-orange-500/10"
                >
                  <Power className="h-4 w-4 mr-2" />
                  Pausar Todos
                </Button>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg bg-[#2a2a2a]/30">
                <div>
                  <p className="text-sm font-medium">Exportar Dados</p>
                  <p className="text-xs text-[#64748b]">
                    Baixe seus leads e mensagens em formato CSV
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        const { data, error } = await supabase.from("leads").select("*");
                        if (error) throw error;
                        if (data && data.length) downloadCSV(data, "leads");
                        else toast.info("Nenhum lead para exportar.");
                      } catch (e: any) {
                        console.error("[Settings] export leads falhou:", e);
                        toast.error("Não foi possível exportar leads.");
                      }
                    }}
                    className="border-[#2a2a2a]"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Leads
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        const { data, error } = await supabase.from("messages").select("*");
                        if (error) throw error;
                        if (data && data.length) downloadCSV(data, "mensagens");
                        else toast.info("Nenhuma mensagem para exportar.");
                      } catch (e: any) {
                        console.error("[Settings] export messages falhou:", e);
                        toast.error("Não foi possível exportar mensagens.");
                      }
                    }}
                    className="border-[#2a2a2a]"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Mensagens
                  </Button>
                </div>
              </div>

              <div className="pt-6 border-t border-red-500/20">
                <Button
                  variant="destructive"
                  onClick={handleDeleteAccount}
                  disabled={isDeleting}
                  className="w-full sm:w-auto"
                >
                  {isDeleting ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <Trash2 className="h-4 w-4 mr-2" />
                  )}
                  Excluir Minha Conta Permanentemente
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      <div className="h-20" />
    </div>
  );
}
