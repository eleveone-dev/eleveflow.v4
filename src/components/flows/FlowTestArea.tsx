import { useState, useEffect, useRef } from "react";
import {
  Beaker,
  Info,
  Play,
  Smartphone,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Terminal,
  Send,
  Clock,
} from "lucide-react";
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
import { useFlows } from "@/hooks/use-flows";
import { useExecuteFlow, useAccount } from "@/hooks/use-crm";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { safeText } from "@/lib/utils/safeData";
import { normalizeBrazilPhone } from "@/lib/phone";
import { processQueueBatch } from "@/services/queueService";

type LogEntry = {
  msg: string;
  type: "info" | "success" | "error" | "warning" | "terminal";
  time: Date;
};

export function FlowTestArea() {
  const { data: flows, isLoading: flowsLoading } = useFlows();
  const { data: account } = useAccount();
  const executeFlow = useExecuteFlow();

  const [selectedFlowId, setSelectedFlowId] = useState<string>("");
  const [testPhone, setTestPhone] = useState<string>("");
  const [isTesting, setIsTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<
    "idle" | "starting" | "creating_lead" | "executing" | "processing_queue" | "success" | "error"
  >("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [queueItemStatus, setQueueItemStatus] = useState<string | null>(null);

  const addLog = (msg: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [{ msg, type, time: new Date() }, ...prev].slice(0, 50));
  };

  useEffect(() => {
    const settings = account?.settings as any;
    if (settings?.test_phone) {
      setTestPhone(settings.test_phone);
    }
  }, [account]);

  const validatePhone = (phone: string) => {
    const normalized = normalizeBrazilPhone(phone);
    if (!normalized) return { valid: false, error: "Formato inválido" };
    if (!normalized.startsWith("55"))
      return { valid: false, error: "Deve começar com 55 (Brasil)" };
    if (normalized.length < 12 || normalized.length > 13)
      return { valid: false, error: "Número deve ter entre 12 e 13 dígitos" };
    return { valid: true, normalized };
  };

  const handleRunTest = async () => {
    if (!selectedFlowId) {
      toast.error("Selecione um fluxo para testar.");
      return;
    }
    if (!testPhone) {
      toast.error("Informe um número de WhatsApp para o teste.");
      return;
    }

    const { valid, normalized, error } = validatePhone(testPhone);
    if (!valid) {
      toast.error(`Telefone inválido: ${error}`);
      return;
    }

    if (account?.whatsapp_status !== "connected") {
      toast.error("WhatsApp desconectado. Conecte antes de testar.");
      return;
    }

    setIsTesting(true);
    setTestStatus("starting");
    setLogs([]);
    setQueueItemStatus(null);
    addLog(`Iniciando teste de fluxo para ${normalized}...`, "terminal");

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Não autenticado");

      // 1. Create temporary test lead
      setTestStatus("creating_lead");
      addLog("Criando lead temporário para teste...", "info");

      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .insert({
          user_id: user.id,
          name: "Teste EleveFlow",
          phone: normalized || "",
          tags: ["teste-area"],
          company: "Ambiente de Teste",
        })
        .select()
        .single();

      if (leadError) throw new Error(`Falha ao criar lead: ${leadError.message}`);
      addLog(`Lead de teste criado: ID ${lead.id}`, "success");

      setTestStatus("executing");
      addLog("Invocando execução do fluxo...", "info");

      // 2. Execute flow (this adds to send_queue)
      const executionResult = await executeFlow.mutateAsync({
        leadId: lead.id,
        flowId: selectedFlowId,
        triggerType: "manual",
      });

      addLog(
        `Fluxo acionado. Passos executados: ${executionResult.steps_executed || 0}`,
        "success",
      );

      // 3. Process queue immediately
      setTestStatus("processing_queue");
      addLog("Buscando item agendado na fila...", "info");

      // Wait a bit for the trigger to insert into queue
      addLog("Aguardando geração da mensagem na fila...", "info");
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const { data: queueItems } = await supabase
        .from("send_queue")
        .select("id, status")
        .eq("lead_id", lead.id)
        .eq("flow_id", selectedFlowId)
        .order("created_at", { ascending: false })
        .limit(1);

      const queueItem = queueItems?.[0];

      if (queueItem) {
        addLog(
          `Item da fila encontrado: ID ${queueItem.id}. Status inicial: ${queueItem.status}`,
          "info",
        );
        setQueueItemStatus(queueItem.status);

        if (queueItem.status === "pending") {
          addLog("Processando fila agora para envio imediato...", "warning");
          const processResult = await processQueueBatch(5);
          addLog(
            `Processamento concluído. Processados: ${processResult.processed}, Falhas: ${processResult.failed}`,
            processResult.failed > 0 ? "error" : "success",
          );
        }

        // 4. Poll for final status
        addLog("Verificando status real de envio...", "info");
        let attempts = 0;
        let finalStatus = queueItem.status;

        while (attempts < 5 && finalStatus !== "sent" && finalStatus !== "failed") {
          attempts++;
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const { data: updatedItem } = await supabase
            .from("send_queue")
            .select("status")
            .eq("id", queueItem.id)
            .single();

          if (updatedItem) {
            finalStatus = updatedItem.status;
            setQueueItemStatus(finalStatus);
            addLog(`Status da fila: ${finalStatus}`, "info");
          }
        }

        if (finalStatus === "sent") {
          setTestStatus("success");
          addLog("MENSAGEM ENVIADA COM SUCESSO!", "success");
          toast.success("Mensagem enviada com sucesso!");
        } else if (finalStatus === "failed") {
          setTestStatus("error");
          addLog("FALHA AO ENVIAR MENSAGEM. Verifique os logs do WhatsApp.", "error");
          toast.error("Falha ao enviar mensagem");
        } else {
          setTestStatus("idle"); // Back to idle but show queue status
          addLog("A mensagem foi agendada na fila, mas ainda não foi processada.", "warning");
          toast.warning("Mensagem agendada na fila");
        }
      } else {
        addLog(
          "Aviso: Nenhum item de mensagem foi gerado por este fluxo. Verifique se o fluxo possui blocos de mensagem.",
          "warning",
        );
        setTestStatus("success");
      }

      // Cleanup lead
      setTimeout(async () => {
        await supabase.from("leads").delete().eq("id", lead.id);
      }, 30000);
    } catch (err: any) {
      console.error("[FlowTestArea] Erro:", err);
      setTestStatus("error");
      addLog(`ERRO: ${err.message}`, "error");
      toast.error(`Falha no teste: ${err.message}`);
    } finally {
      setIsTesting(false);
    }
  };

  const getStatusText = () => {
    if (isTesting) {
      switch (testStatus) {
        case "starting":
          return "Iniciando teste...";
        case "creating_lead":
          return "Preparando Lead...";
        case "executing":
          return "Executando Fluxo...";
        case "processing_queue":
          return "Processando Fila...";
        default:
          return "Trabalhando...";
      }
    }
    if (testStatus === "success") return "Mensagem enviada com sucesso";
    if (testStatus === "error") return "Falha ao enviar mensagem";
    if (queueItemStatus === "pending") return "Mensagem agendada na fila";
    return "Disparar Teste Agora";
  };

  return (
    <div className="mt-8 space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="bg-[#111118] border border-[#2a2a3a] rounded-2xl overflow-hidden shadow-2xl">
        <div className="p-6 border-b border-[#2a2a3a] bg-[#1a1a24]/50 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <Beaker className="h-5 w-5 text-[#7c3aed]" />
              Laboratório de Testes V2
            </h2>
            <p className="text-xs text-[#64748b] mt-1">Validação real de envio pelo WhatsApp.</p>
          </div>
          <div className="flex items-center gap-2">
            <div
              className={`h-2 w-2 rounded-full ${account?.whatsapp_status === "connected" ? "bg-green-500 animate-pulse" : "bg-red-500 shadow-[0_0_10px_red]"}`}
            />
            <span className="text-[10px] font-bold text-[#475569] uppercase tracking-widest">
              {account?.whatsapp_status === "connected" ? "WhatsApp Online" : "WhatsApp Offline"}
            </span>
          </div>
        </div>

        <div className="p-8 lg:p-12">
          <div className="max-w-xl mx-auto space-y-8">
            <div className="grid gap-6">
              <div className="space-y-3">
                <Label className="text-xs font-bold uppercase tracking-widest text-[#94a3b8]">
                  1. Selecione o Fluxo
                </Label>
                <Select value={selectedFlowId} onValueChange={setSelectedFlowId}>
                  <SelectTrigger className="h-12 bg-[#0d0d14] border-[#2a2a3a] text-white">
                    <SelectValue placeholder="Selecione um fluxo para testar..." />
                  </SelectTrigger>
                  <SelectContent className="bg-[#111118] border-[#2a2a3a] text-white">
                    {flowsLoading ? (
                      <div className="p-4 flex items-center justify-center">
                        <Loader2 className="h-4 w-4 animate-spin" />
                      </div>
                    ) : (
                      flows?.map((flow) => (
                        <SelectItem key={flow.id} value={flow.id} className="focus:bg-[#7c3aed20]">
                          {safeText(flow.name)}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3">
                <Label className="text-xs font-bold uppercase tracking-widest text-[#94a3b8]">
                  2. Número de Destino (DDI+DDD+Número)
                </Label>
                <div className="relative">
                  <Smartphone className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-[#475569]" />
                  <Input
                    placeholder="37999326861"
                    value={testPhone}
                    onChange={(e) => setTestPhone(e.target.value)}
                    className="h-12 pl-12 bg-[#0d0d14] border-[#2a2a3a] text-white"
                  />
                </div>
                <p className="text-[10px] text-[#475569] italic">
                  O sistema irá normalizar para 5537999326861 automaticamente.
                </p>
              </div>
            </div>

            <div className="pt-4">
              <Button
                onClick={handleRunTest}
                disabled={
                  isTesting ||
                  !selectedFlowId ||
                  !testPhone ||
                  account?.whatsapp_status !== "connected"
                }
                className={`w-full h-14 text-base font-bold transition-all shadow-xl ${
                  testStatus === "success"
                    ? "bg-green-600 hover:bg-green-700"
                    : testStatus === "error"
                      ? "bg-red-600 hover:bg-red-700"
                      : queueItemStatus === "pending"
                        ? "bg-yellow-600 hover:bg-yellow-700"
                        : "bg-[#7c3aed] hover:bg-[#6d28d9]"
                }`}
              >
                {isTesting ? (
                  <>
                    <Loader2 className="h-5 w-5 mr-3 animate-spin" />
                    {getStatusText()}
                  </>
                ) : testStatus === "success" ? (
                  <>
                    <CheckCircle2 className="h-5 w-5 mr-3" />
                    {getStatusText()}
                  </>
                ) : testStatus === "error" ? (
                  <>
                    <AlertCircle className="h-5 w-5 mr-3" />
                    {getStatusText()}
                  </>
                ) : queueItemStatus === "pending" ? (
                  <>
                    <Clock className="h-5 w-5 mr-3" />
                    {getStatusText()}
                  </>
                ) : (
                  <>
                    <Play className="h-5 w-5 mr-3" />
                    Disparar Teste Agora
                  </>
                )}
              </Button>

              {account?.whatsapp_status !== "connected" && (
                <div className="mt-4 flex items-center justify-center gap-2 text-red-500 bg-red-500/5 p-3 rounded-xl border border-red-500/10">
                  <AlertCircle className="h-4 w-4" />
                  <span className="text-xs font-bold">Conecte o WhatsApp para realizar testes</span>
                </div>
              )}
            </div>

            {logs.length > 0 && (
              <div className="mt-8 rounded-2xl bg-[#0d0d14] border border-[#2a2a3a] overflow-hidden">
                <div className="p-4 border-b border-[#2a2a3a] bg-[#1a1a24]/50 flex items-center justify-between">
                  <h4 className="text-[10px] font-bold uppercase tracking-widest text-[#94a3b8] flex items-center gap-2">
                    <Terminal className="h-3 w-3" />
                    Log de Operação em Tempo Real
                  </h4>
                  {isTesting && (
                    <div className="flex items-center gap-1">
                      <div className="h-1.5 w-1.5 bg-green-500 rounded-full animate-pulse" />
                      <span className="text-[8px] text-green-500 font-bold uppercase tracking-widest">
                        Processando
                      </span>
                    </div>
                  )}
                </div>
                <div className="p-6 h-[250px] overflow-y-auto space-y-2 font-mono text-[11px] bg-black/40">
                  {logs.map((log, i) => (
                    <div
                      key={i}
                      className="flex gap-3 border-l-2 border-transparent hover:border-[#7c3aed]/30 pl-2 transition-all"
                    >
                      <span className="text-[#475569] shrink-0">
                        [{log.time.toLocaleTimeString()}]
                      </span>
                      <span
                        className={`
                        ${
                          log.type === "error"
                            ? "text-red-400 font-bold"
                            : log.type === "success"
                              ? "text-green-400 font-bold"
                              : log.type === "warning"
                                ? "text-yellow-400"
                                : log.type === "terminal"
                                  ? "text-blue-300 italic"
                                  : "text-[#94a3b8]"
                        }
                      `}
                      >
                        {log.msg}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="p-6 bg-[#1a1a24]/30 border-t border-[#2a2a3a] flex items-start gap-4">
          <Info className="h-5 w-5 text-[#7c3aed] mt-0.5 shrink-0" />
          <div className="text-xs text-[#64748b] leading-relaxed">
            <p>
              <strong>Critério de Sucesso:</strong> O teste só é considerado bem-sucedido quando a O
              provedor confirma o envio real da mensagem (status "sent").
            </p>
            <p className="mt-1">
              Ações como criação de lead e agendamento na fila são mostradas em tempo real no
              terminal acima.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
