import { useFlows, useDeleteFlow, useUpdateFlow, useCreateFlow } from "@/hooks/use-flows";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useStages } from "@/hooks/use-crm";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Plus, Edit2, Trash2, GitBranch, Users, Loader2, Beaker } from "lucide-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { FlowTestArea } from "@/components/flows/FlowTestArea";
import { SafeFlowTestModal } from "@/components/flows/SafeFlowTestModal";
import { safeText } from "@/lib/utils/safeData";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function FlowsPage() {
  const { data: flows, isLoading } = useFlows();
  const { data: stages, error: stagesError } = useStages();
  const deleteFlow = useDeleteFlow();
  const updateFlow = useUpdateFlow();
  const createFlow = useCreateFlow();
  const navigate = useNavigate();
  const search = useSearch({ from: "/flows" }) as any;

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [showTestArea, setShowTestArea] = useState(false);
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [selectedTestFlow, setSelectedTestFlow] = useState<any>(null);
  const [newFlow, setNewFlow] = useState({ name: "", description: "", trigger_stage_id: "none" });

  useEffect(() => {
    if (search?.tab === "test") {
      setShowTestArea(true);
    }
  }, [search]);

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === "f" &&
        !["input", "textarea"].includes((e.target as HTMLElement).tagName.toLowerCase())
      ) {
        setIsDialogOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, []);

  const handleCreateFlow = async (redirect: boolean = true) => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        toast.error("Você precisa estar logado.");
        return;
      }

      console.log("User ID:", user.id);
      console.log("Stages encontrados:", stages);

      const triggerStageId = newFlow.trigger_stage_id === "none" ? null : newFlow.trigger_stage_id;

      createFlow.mutate(
        {
          name: newFlow.name,
          description: newFlow.description,
          trigger_stage_id: triggerStageId,
          trigger_type: triggerStageId ? "stage_enter" : "manual",
          user_id: user.id,
          is_active: false,
        },
        {
          onSuccess: (data) => {
            setIsDialogOpen(false);
            setNewFlow({ name: "", description: "", trigger_stage_id: "none" });
            if (redirect) {
              navigate({ to: `/flows/${data.id}/edit` as any });
            }
          },
          onError: (error: any) => {
            console.error("Erro ao criar fluxo:", error);
            toast.error(`Erro ao criar fluxo: ${error.message || "Erro desconhecido"}`);
          },
        },
      );
    } catch (err: any) {
      console.error("Crash ao criar fluxo:", err);
      toast.error("Ocorreu um erro inesperado ao processar a criação.");
    }
  };

  const toggleFlowStatus = (id: string, currentStatus: boolean | null) => {
    if (!id) {
      toast.error("Fluxo inválido.");
      return;
    }
    try {
      updateFlow.mutate({ id, is_active: !currentStatus });
    } catch (err) {
      console.error("[Flows] toggle falhou:", err);
      toast.error("Não foi possível alterar o status do fluxo.");
    }
  };

  const openSafeFlowTest = (flow: any) => {
    try {
      if (!flow?.id) {
        toast.error("Fluxo inválido para teste.");
        return;
      }
      setSelectedTestFlow(flow);
      setTestModalOpen(true);
    } catch (error) {
      console.error("Erro ao abrir teste seguro:", error);
      toast.error("Não foi possível abrir o teste deste fluxo.");
    }
  };

  if (isLoading) {
    return <div className="p-8 text-center text-[#64748b]">Carregando fluxos...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Fluxos de Automação</h1>
          <p className="text-[#64748b]">Gerencie suas sequências automáticas de mensagens</p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => setIsDialogOpen(true)}
            className="bg-[#6366f1] hover:bg-[#6366f1]/90"
          >
            <Plus className="h-4 w-4 mr-2" />
            Novo Fluxo
          </Button>
        </div>
      </div>

      <div className="flex border-b border-[#2a2a3a] gap-8">
        <button
          onClick={() => setShowTestArea(false)}
          className={`pb-4 text-sm font-bold transition-all border-b-2 ${!showTestArea ? "text-[#7c3aed] border-[#7c3aed]" : "text-[#64748b] border-transparent hover:text-white"}`}
        >
          Meus Fluxos
        </button>
        <button
          onClick={() => setShowTestArea(true)}
          className={`pb-4 text-sm font-bold transition-all border-b-2 ${showTestArea ? "text-[#7c3aed] border-[#7c3aed]" : "text-[#64748b] border-transparent hover:text-white"}`}
        >
          <div className="flex items-center gap-2">
            <Beaker className="h-4 w-4" />
            Testar Fluxo
          </div>
        </button>
      </div>

      {showTestArea ? (
        <ErrorBoundary>
          <FlowTestArea />
        </ErrorBoundary>
      ) : (
        <>
          {flows?.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 bg-[#111118] rounded-xl border border-dashed border-[#2a2a3a] space-y-6">
              <div className="p-6 rounded-full bg-[#7c3aed10] shadow-2xl shadow-[#7c3aed10]">
                <GitBranch className="h-12 w-12 text-[#7c3aed]" />
              </div>
              <div className="text-center space-y-2">
                <h3 className="text-xl font-bold text-white">Nenhum fluxo criado</h3>
                <p className="text-[#94a3b8] max-w-sm">
                  Automatize seus atendimentos criando sequências de mensagens inteligentes.
                </p>
              </div>
              <Button
                onClick={() => setIsDialogOpen(true)}
                className="bg-[#7c3aed] hover:bg-[#6d28d9] h-12 px-8"
              >
                <Plus className="h-5 w-5 mr-2" /> Criar Meu Primeiro Fluxo
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {(Array.isArray(flows) ? flows : [])
                .filter((f) => f && f.id)
                .map((flow) => {
                  const triggerStage = flow.trigger_stage_id
                    ? (Array.isArray(stages) ? stages : []).find(
                        (s) => s && s.id === flow.trigger_stage_id,
                      )
                    : null;
                  const stageColor = triggerStage?.color || "#7c3aed";

                  return (
                    <Card
                      key={flow.id}
                      className="group relative overflow-hidden border-l-4"
                      style={{ borderLeftColor: stageColor }}
                    >
                      <CardHeader className="pb-4">
                        <div className="flex justify-between items-start">
                          <div className="flex items-center space-x-3">
                            <div className="p-2 rounded-lg bg-[#7c3aed10] text-[#7c3aed]">
                              <GitBranch className="h-5 w-5" />
                            </div>
                            <CardTitle className="text-lg font-bold group-hover:text-[#7c3aed] transition-colors">
                              {safeText(flow.name)}
                            </CardTitle>
                          </div>
                          <Switch
                            checked={flow.is_active || false}
                            onCheckedChange={() => toggleFlowStatus(flow.id, flow.is_active)}
                            className="data-[state=checked]:bg-[#7c3aed]"
                          />
                        </div>
                        <CardDescription className="text-[#94a3b8] mt-2 line-clamp-2">
                          {safeText(
                            flow.description ||
                              "Sem descrição definida para este fluxo automático.",
                          )}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-4">
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline" className="bg-[#1a1a24] border-[#2a2a3a]">
                              {Array.isArray(flow.flow_blocks) ? flow.flow_blocks.length : 0} blocos
                            </Badge>
                            {flow.trigger_stage_id && triggerStage && (
                              <Badge variant="default">
                                Gatilho: {safeText(triggerStage.name || "Palco")}
                              </Badge>
                            )}
                            <Badge variant="secondary" className="flex items-center gap-1">
                              <Users className="h-3 w-3" />0 leads ativos
                            </Badge>
                          </div>

                          <div className="flex justify-between items-center pt-5 border-t border-[#2a2a3a]">
                            <div className="flex gap-1.5">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  try {
                                    if (!flow?.id) {
                                      toast.error("Fluxo inválido.");
                                      return;
                                    }
                                    navigate({ to: `/flows/${flow.id}/edit` as any });
                                  } catch (err) {
                                    console.error("[Flows] navegar editar falhou:", err);
                                    toast.error("Não foi possível abrir o editor.");
                                  }
                                }}
                                className="h-9 px-4 border-[#2a2a3a] text-[#94a3b8] hover:border-[#7c3aed] hover:text-white transition-all font-bold text-xs"
                              >
                                <Edit2 className="h-3.5 w-3.5 mr-2" />
                                Editar
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                type="button"
                                onClick={(e) => {
                                  try {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (!flow?.id) {
                                      toast.error("Fluxo inválido para teste.");
                                      return;
                                    }
                                    openSafeFlowTest(flow);
                                  } catch (err) {
                                    console.error("[Flows] clicar testar falhou:", err);
                                    toast.error("Erro ao abrir modal de teste.");
                                  }
                                }}
                                className="h-9 px-4 border-[#2a2a3a] text-[#94a3b8] hover:border-[#10b981] hover:text-white transition-all font-bold text-xs"
                              >
                                <Beaker className="h-3.5 w-3.5 mr-2" />
                                Testar
                              </Button>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                try {
                                  if (!flow?.id) {
                                    toast.error("Fluxo inválido.");
                                    return;
                                  }
                                  if (
                                    window.confirm(
                                      `Deseja realmente excluir o fluxo "${flow.name}"? Esta ação não pode ser desfeita.`,
                                    )
                                  ) {
                                    deleteFlow.mutate(flow.id);
                                  }
                                } catch (err) {
                                  console.error("[Flows] delete falhou:", err);
                                  toast.error("Não foi possível excluir o fluxo.");
                                }
                              }}
                              className="h-9 px-4 border-red-500/30 text-red-400 hover:border-red-500 hover:bg-red-500/10 hover:text-red-300 transition-all font-bold text-xs"
                              disabled={deleteFlow.isPending}
                            >
                              {deleteFlow.isPending ? (
                                <>
                                  <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Excluindo...
                                </>
                              ) : (
                                <>
                                  <Trash2 className="h-3.5 w-3.5 mr-2" /> Excluir
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
            </div>
          )}
        </>
      )}

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="bg-[#111118] border-[#2a2a3a]">
          <DialogHeader>
            <DialogTitle className="text-white">Criar Novo Fluxo</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="flow-name" className="text-white">
                Nome do Fluxo *
              </Label>
              <Input
                id="flow-name"
                value={newFlow.name}
                onChange={(e) => setNewFlow({ ...newFlow, name: e.target.value })}
                placeholder="Ex: Boas-vindas para novos leads"
                className="bg-[#1a1a24] border-[#2a2a3a] text-white"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="flow-desc" className="text-white">
                Descrição
              </Label>
              <Input
                id="flow-desc"
                value={newFlow.description}
                onChange={(e) => setNewFlow({ ...newFlow, description: e.target.value })}
                placeholder="Descreva o objetivo deste fluxo"
                className="bg-[#1a1a24] border-[#2a2a3a] text-white"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-white">Gatilho (Etapa do Pipeline)</Label>
              <Select
                value={newFlow.trigger_stage_id}
                onValueChange={(value) => setNewFlow({ ...newFlow, trigger_stage_id: value })}
              >
                <SelectTrigger className="bg-[#1a1a24] border-[#2a2a3a] text-white">
                  <SelectValue placeholder="Selecione uma etapa (opcional)" />
                </SelectTrigger>
                <SelectContent className="bg-[#1a1a24] border-[#2a2a3a]">
                  <SelectItem value="none">Manual (sem gatilho automático)</SelectItem>
                  {(Array.isArray(stages) ? stages : [])
                    .filter((s) => s && s.id)
                    .map((stage) => (
                      <SelectItem key={stage.id} value={stage.id}>
                        {safeText(stage.name)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-[#64748b]">
                Quando um lead entrar nesta etapa, o fluxo será disparado automaticamente.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDialogOpen(false)}
              className="border-[#2a2a3a] text-[#94a3b8]"
            >
              Cancelar
            </Button>
            <Button
              onClick={() => handleCreateFlow(true)}
              disabled={!newFlow.name.trim() || createFlow.isPending}
              className="bg-[#7c3aed] hover:bg-[#6d28d9]"
            >
              {createFlow.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Criando...
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-2" /> Criar Fluxo
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SafeFlowTestModal
        open={testModalOpen}
        flow={selectedTestFlow}
        onClose={() => setTestModalOpen(false)}
      />

      <div className="h-20" />
    </div>
  );
}
