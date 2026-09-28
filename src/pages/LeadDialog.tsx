import { useState, useEffect } from "react";
import { safeText } from "@/lib/utils/safeData";
// Mesma regra do servidor, importada do módulo compartilhado: duas cópias da
// regra divergiriam, e a tela passaria a dizer o contrário do que o fluxo faz.
import { canReceiveWhatsApp } from "../../supabase/functions/_shared/whatsapp/phone-target";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useCreateLead, useUpdateLead, useStages, useFlowExecutions } from "@/hooks/use-crm";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Play, Pause, RotateCcw, Clock, CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { FlowSelectionDialog } from "./FlowSelectionDialog";

type MarketingConsentStatus = "unknown" | "granted" | "denied" | "withdrawn" | "not_required";

const MARKETING_CONSENT_OPTIONS: Array<{ value: MarketingConsentStatus; label: string }> = [
  { value: "unknown", label: "Pendente de definição" },
  { value: "granted", label: "Consentimento concedido" },
  { value: "not_required", label: "Base legal registrada (não requer consentimento)" },
  { value: "denied", label: "Consentimento negado" },
  { value: "withdrawn", label: "Opt-out / consentimento revogado" },
];

function normalizeBrazilianWhatsApp(value: string): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  const national =
    digits.startsWith("55") && (digits.length === 12 || digits.length === 13)
      ? digits.slice(2)
      : digits;
  return national.length === 10 || national.length === 11 ? `55${national}` : null;
}

export function LeadDialog({
  open,
  onOpenChange,
  lead,
  defaultStageId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead?: any;
  defaultStageId?: string;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [stageId, setStageId] = useState(defaultStageId || lead?.stage_id || "");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [marketingConsentStatus, setMarketingConsentStatus] =
    useState<MarketingConsentStatus>("unknown");
  const [isSuppressed, setIsSuppressed] = useState(false);
  const [suppressionReason, setSuppressionReason] = useState("");
  const [isFlowSelectionOpen, setIsFlowSelectionOpen] = useState(false);

  const handleManualSend = () => {
    if (!lead?.id) return;
    if (isSuppressed || !["granted", "not_required"].includes(marketingConsentStatus)) {
      toast.error(
        "Defina uma base legal válida e remova o bloqueio de contato antes de iniciar um fluxo.",
      );
      return;
    }
    setIsFlowSelectionOpen(true);
  };

  const { data: stages } = useStages();
  const createLead = useCreateLead();
  const updateLead = useUpdateLead();
  const { data: executions, refetch: refetchExecutions } = useFlowExecutions(lead?.id);

  const handlePauseFlow = async (execId: string) => {
    const { error } = await supabase
      .from("flow_executions")
      .update({ status: "paused" })
      .eq("id", execId);
    if (error) toast.error("Erro ao pausar fluxo");
    else {
      toast.success("Fluxo pausado");
      refetchExecutions();
    }
  };

  const handleResumeFlow = async (execId: string) => {
    const { error } = await supabase
      .from("flow_executions")
      .update({ status: "running" })
      .eq("id", execId);
    if (error) toast.error("Erro ao retomar fluxo");
    else {
      toast.success("Fluxo retomado");
      refetchExecutions();
    }
  };

  const handleRestartFlow = async (execId: string, flowId: string) => {
    if (isSuppressed || !["granted", "not_required"].includes(marketingConsentStatus)) {
      toast.error("Este lead está bloqueado para automações de marketing.");
      return;
    }
    const { error } = await supabase
      .from("flow_executions")
      .update({ status: "completed" })
      .eq("id", execId);
    if (error) {
      toast.error("Erro ao encerrar execução anterior");
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error: execError } = await supabase.functions
      .invoke("execute-flow", {
        body: { lead_id: lead.id, flow_id: flowId, user_id: user?.id, trigger_type: "manual" },
      })
      .catch((e) => {
        console.error("Invoke error:", e);
        return { error: e };
      });

    if (execError) toast.error("Erro ao reiniciar fluxo");
    else {
      toast.success("Fluxo reiniciado");
      refetchExecutions();
    }
  };

  useEffect(() => {
    if (lead) {
      setName(lead.name || "");
      setPhone(lead.phone || "");
      setCompany(lead.company || "");
      setEmail(lead.email || "");
      setStageId(lead.stage_id || "");
      setNotes(lead.notes || "");
      setTags(lead.tags?.join(", ") || "");
      setMarketingConsentStatus(
        (lead.marketing_consent_status || "unknown") as MarketingConsentStatus,
      );
      setIsSuppressed(Boolean(lead.is_suppressed || lead.marketing_opted_out_at));
      setSuppressionReason(lead.suppression_reason || lead.marketing_opt_out_reason || "");
    } else {
      setName("");
      setPhone("");
      setCompany("");
      setEmail("");
      setStageId(defaultStageId || "");
      setNotes("");
      setTags("");
      setMarketingConsentStatus("unknown");
      setIsSuppressed(false);
      setSuppressionReason("");
    }
  }, [lead, open, defaultStageId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const now = new Date().toISOString();
    const hasRecordedOptOut = Boolean(lead?.marketing_opted_out_at);
    const effectiveConsentStatus: MarketingConsentStatus = hasRecordedOptOut
      ? "withdrawn"
      : marketingConsentStatus;
    const isConsentBlocked =
      effectiveConsentStatus === "denied" || effectiveConsentStatus === "withdrawn";
    const contactBlocked = hasRecordedOptOut || isSuppressed || isConsentBlocked;
    const resolvedSuppressionReason =
      suppressionReason.trim() ||
      (effectiveConsentStatus === "withdrawn" ? "Opt-out registrado" : "Contato bloqueado");
    const normalizedWhatsapp = normalizeBrazilianWhatsApp(phone);
    const leadData = {
      name,
      phone,
      whatsapp: normalizedWhatsapp,
      has_whatsapp: Boolean(normalizedWhatsapp),
      company,
      email,
      stage_id: stageId || null,
      notes,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== ""),
      user_id: user.id,
      marketing_consent_status: effectiveConsentStatus,
      marketing_consent_at:
        effectiveConsentStatus === "granted" ? lead?.marketing_consent_at || now : null,
      marketing_opted_out_at:
        effectiveConsentStatus === "withdrawn" ? lead?.marketing_opted_out_at || now : null,
      marketing_opt_out_reason:
        effectiveConsentStatus === "withdrawn" ? resolvedSuppressionReason : null,
      is_suppressed: contactBlocked,
      suppressed_at: contactBlocked ? lead?.suppressed_at || now : null,
      suppression_reason: contactBlocked ? resolvedSuppressionReason : null,
    };

    if (lead) {
      updateLead.mutate(
        { id: lead.id, ...leadData },
        {
          onSuccess: () => onOpenChange(false),
        },
      );
    } else {
      createLead.mutate(leadData, {
        onSuccess: () => onOpenChange(false),
      });
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-[#111118] border-[#2a2a3a] text-white max-w-2xl p-0 overflow-hidden shadow-2xl">
          <DialogHeader className="p-8 pb-0">
            <DialogTitle className="text-xl font-bold tracking-tight">
              {lead ? `Detalhes do Lead: ${lead.name}` : "Novo Lead"}
            </DialogTitle>
          </DialogHeader>

          <Tabs defaultValue="info" className="w-full">
            <TabsList className="bg-[#0d0d14] border-b border-[#2a2a3a] w-full justify-start rounded-none h-14 px-8 mb-0">
              <TabsTrigger
                value="info"
                className="data-[state=active]:bg-transparent data-[state=active]:text-[#7c3aed] data-[state=active]:border-b-2 data-[state=active]:border-[#7c3aed] rounded-none h-full px-6 transition-all font-bold uppercase tracking-widest text-[10px]"
              >
                Informações
              </TabsTrigger>
              {lead && (
                <TabsTrigger
                  value="flows"
                  className="data-[state=active]:bg-transparent data-[state=active]:text-[#7c3aed] data-[state=active]:border-b-2 data-[state=active]:border-[#7c3aed] rounded-none h-full px-6 transition-all font-bold uppercase tracking-widest text-[10px]"
                >
                  Automações
                </TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="info">
              <form
                onSubmit={handleSubmit}
                className="space-y-6 max-h-[60vh] overflow-y-auto p-8 pt-6"
              >
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="lead-name">Nome</Label>
                    <Input
                      id="lead-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="bg-[#0f0f0f] border-[#2a2a2a]"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lead-phone">Telefone</Label>
                    <Input
                      id="lead-phone"
                      value={phone}
                      onChange={(e) => {
                        let val = e.target.value.replace(/\D/g, "");
                        if (val.length <= 11) {
                          if (val.length > 10) {
                            val = val.replace(/^(\d{2})(\d{5})(\d{4}).*/, "($1) $2-$3");
                          } else if (val.length > 6) {
                            val = val.replace(/^(\d{2})(\d{4})(\d{0,4}).*/, "($1) $2-$3");
                          } else if (val.length > 2) {
                            val = val.replace(/^(\d{2})(\d{0,5}).*/, "($1) $2");
                          } else if (val.length > 0) {
                            val = val.replace(/^(\d{0,2}).*/, "($1");
                          }
                          setPhone(val);
                        }
                      }}
                      placeholder="(11) 99999-9999"
                      className="bg-[#0f0f0f] border-[#2a2a2a]"
                      required
                    />
                    {/* Mesma regra que o fluxo usa para recusar o envio. Dizer
                        aqui é o que permite corrigir o cadastro, em vez de o lead
                        ficar parado sem motivo visível. Avalia o que está digitado
                        agora, não o que está gravado. */}
                    {(() => {
                      const alvo = canReceiveWhatsApp({ phone, whatsapp: lead?.whatsapp });
                      if (alvo.ok) return null;
                      return (
                        <p className="flex items-start gap-1.5 text-xs text-[#fbbf24]">
                          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                          <span>
                            Este número pode estar errado:{" "}
                            {alvo.reason === "landline"
                              ? "parece um telefone fixo, não WhatsApp"
                              : "está incompleto (falta DDD)"}
                            . Enquanto estiver assim, o fluxo não envia mensagem para este lead.
                          </span>
                        </p>
                      );
                    })()}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="lead-company">Empresa</Label>
                    <Input
                      id="lead-company"
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
                      className="bg-[#0f0f0f] border-[#2a2a2a]"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lead-email">Email</Label>
                    <Input
                      id="lead-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="bg-[#0f0f0f] border-[#2a2a2a]"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lead-stage">Estágio</Label>
                  <Select value={stageId} onValueChange={setStageId}>
                    <SelectTrigger className="bg-[#0f0f0f] border-[#2a2a2a]">
                      <SelectValue placeholder="Selecione um estágio" />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1a1a1a] border-[#2a2a2a]">
                      {(Array.isArray(stages) ? stages : []).map((stage) => (
                        <SelectItem key={stage.id} value={stage.id}>
                          {safeText(stage.name)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lead-tags">Tags (separadas por vírgula)</Label>
                  <Input
                    id="lead-tags"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="venda, urgente, hot"
                    className="bg-[#0f0f0f] border-[#2a2a2a]"
                  />
                </div>
                <div className="space-y-4 rounded-xl border border-[#2a2a3a] bg-[#0f0f0f] p-4">
                  <div className="space-y-2">
                    <Label htmlFor="lead-consent">Situação de marketing</Label>
                    <Select
                      value={marketingConsentStatus}
                      onValueChange={(value) =>
                        setMarketingConsentStatus(value as MarketingConsentStatus)
                      }
                      disabled={Boolean(lead?.marketing_opted_out_at)}
                    >
                      <SelectTrigger id="lead-consent" className="border-[#2a2a2a] bg-[#111118]">
                        <SelectValue placeholder="Selecione a base de contato" />
                      </SelectTrigger>
                      <SelectContent className="border-[#2a2a2a] bg-[#1a1a1a]">
                        {MARKETING_CONSENT_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-[#94a3b8]">
                      Apenas leads com consentimento concedido ou base legal registrada podem
                      receber automações.
                    </p>
                    {lead?.marketing_opted_out_at && (
                      <p className="text-xs text-amber-300">
                        Opt-out recebido por WhatsApp: este lead não pode ser reativado por esta
                        tela. Uma nova adesão precisa ser registrada em fluxo auditável.
                      </p>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-1">
                      <Label htmlFor="lead-suppression">Bloquear contato</Label>
                      <p className="text-xs text-[#94a3b8]">
                        Impede qualquer novo envio, inclusive pela fila.
                      </p>
                    </div>
                    <Switch
                      id="lead-suppression"
                      checked={
                        isSuppressed ||
                        marketingConsentStatus === "denied" ||
                        marketingConsentStatus === "withdrawn"
                      }
                      onCheckedChange={setIsSuppressed}
                      disabled={
                        Boolean(lead?.marketing_opted_out_at) ||
                        marketingConsentStatus === "denied" ||
                        marketingConsentStatus === "withdrawn"
                      }
                    />
                  </div>
                  {(isSuppressed ||
                    marketingConsentStatus === "denied" ||
                    marketingConsentStatus === "withdrawn") && (
                    <div className="space-y-2">
                      <Label htmlFor="lead-suppression-reason">Motivo do bloqueio</Label>
                      <Input
                        id="lead-suppression-reason"
                        value={suppressionReason}
                        onChange={(event) => setSuppressionReason(event.target.value)}
                        placeholder="Ex.: solicitou não receber mensagens"
                        className="border-[#2a2a2a] bg-[#111118]"
                      />
                    </div>
                  )}
                </div>
                <DialogFooter className="pt-4 border-t border-[#2a2a3a] gap-2">
                  {lead && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleManualSend}
                      className="border-[#2a2a3a] text-[#7c3aed] hover:bg-[#7c3aed10] mr-auto"
                    >
                      <Play className="h-4 w-4 mr-2" />
                      Escolher fluxo
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => onOpenChange(false)}
                    className="text-[#475569] hover:text-white"
                  >
                    Cancelar
                  </Button>
                  <Button
                    type="submit"
                    className="bg-[#7c3aed] hover:bg-[#6d28d9] px-8 font-bold h-11 shadow-lg shadow-[#7c3aed]/20"
                    disabled={createLead.isPending || updateLead.isPending}
                  >
                    {(createLead.isPending || updateLead.isPending) && (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    )}
                    {lead ? "Salvar Alterações" : "Criar Lead"}
                  </Button>
                </DialogFooter>
              </form>
            </TabsContent>

            <TabsContent value="flows" className="space-y-4">
              <div className="max-h-[60vh] overflow-y-auto pr-2 space-y-4">
                {executions && Array.isArray(executions) && executions.length > 0 ? (
                  executions.map((exec: any) => (
                    <div
                      key={exec.id}
                      className="p-4 rounded-lg bg-[#0f0f0f] border border-[#2a2a2a] space-y-3"
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <h4 className="font-semibold text-[#f1f5f9]">{exec.flows?.name}</h4>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-[#64748b]">Status:</span>
                            <Badge
                              className={
                                exec.status === "running"
                                  ? "bg-blue-500/10 text-blue-500"
                                  : exec.status === "completed"
                                    ? "bg-green-500/10 text-green-500"
                                    : exec.status === "paused"
                                      ? "bg-yellow-500/10 text-yellow-500"
                                      : "bg-red-500/10 text-red-500"
                              }
                            >
                              {exec.status === "running"
                                ? "Em execução"
                                : exec.status === "completed"
                                  ? "Concluído"
                                  : exec.status === "paused"
                                    ? "Pausado"
                                    : "Erro"}
                            </Badge>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          {exec.status === "running" && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-yellow-500"
                              onClick={() => handlePauseFlow(exec.id)}
                            >
                              <Pause className="h-4 w-4" />
                            </Button>
                          )}
                          {exec.status === "paused" && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-blue-500"
                              onClick={() => handleResumeFlow(exec.id)}
                            >
                              <Play className="h-4 w-4" />
                            </Button>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-indigo-400"
                            onClick={() => handleRestartFlow(exec.id, exec.flow_id)}
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs text-[#64748b]">
                        <div className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          Iniciado em:{" "}
                          {exec.created_at
                            ? new Date(exec.created_at).toLocaleString("pt-BR")
                            : "N/A"}
                        </div>
                        <div className="flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          Última atualização:{" "}
                          {exec.updated_at
                            ? new Date(exec.updated_at).toLocaleString("pt-BR")
                            : "N/A"}
                        </div>
                        {exec.scheduled_at && (
                          <div className="flex items-center gap-1 col-span-2 text-blue-400">
                            <Clock className="h-3 w-3" />
                            Próxima etapa agendada:{" "}
                            {new Date(exec.scheduled_at).toLocaleString("pt-BR")}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-8 text-[#64748b]">
                    Nenhum histórico de fluxos para este lead.
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
      {lead && (
        <FlowSelectionDialog
          open={isFlowSelectionOpen}
          onOpenChange={setIsFlowSelectionOpen}
          leadId={lead.id}
        />
      )}
    </>
  );
}
