import React, { useState, useEffect } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Beaker, Loader2, CheckCircle2, AlertCircle, PlayCircle, RotateCcw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface SafeFlowTestModalProps {
  open: boolean;
  flow: any;
  onClose: () => void;
}

interface LogEntry {
  timestamp: string;
  message: string;
  type: "info" | "success" | "error" | "process";
}

// Utilitário para garantir que valores convertidos para texto não quebrem o React
const safeText = (value: any): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[objeto não serializável]";
    }
  }
  return String(value);
};

export function SafeFlowTestModal({ open, flow, onClose }: SafeFlowTestModalProps) {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [hasInternalError, setHasInternalError] = useState(false);

  const addLog = (message: any, type: LogEntry["type"] = "info") => {
    setLogs((prev) => {
      const newLog: LogEntry = {
        timestamp: new Date().toLocaleTimeString(),
        message: safeText(message),
        type,
      };
      return [newLog, ...prev];
    });
  };

  const normalizePhone = (phone: string) => {
    let cleaned = String(phone || "").replace(/\D/g, "");
    if (cleaned.length === 0) return "";
    if (!cleaned.startsWith("55")) {
      cleaned = "55" + cleaned;
    }
    return cleaned;
  };

  const validatePhone = (phone: string) => {
    return phone.length >= 12 && phone.length <= 13;
  };

  const resetTest = async () => {
    try {
      setIsResetting(true);
      const normalized = normalizePhone(phoneNumber);
      if (!validatePhone(normalized)) {
        toast.error("Informe um WhatsApp válido antes de resetar.");
        return;
      }
      const { data: userData } = await supabase.auth.getUser();
      const user = userData?.user;
      if (!user) {
        toast.error("Usuário não autenticado.");
        return;
      }

      addLog("Resetando histórico de teste...", "process");

      // Encontra o lead de teste deste usuário pelo número
      const { data: leadsFound } = await supabase
        .from("leads")
        .select("id")
        .eq("user_id", user.id)
        .or(`phone.eq.${normalized},whatsapp.eq.${normalized}`);

      const leadIds = (leadsFound || []).map((l: any) => l.id);
      if (leadIds.length === 0) {
        addLog("Nenhum lead de teste encontrado para esse número — nada a limpar.", "info");
        setLogs([]);
        toast.success("Histórico limpo.");
        return;
      }

      // Limpa fila, mensagens, execuções e logs vinculados ao(s) lead(s) de teste
      await Promise.all([
        supabase.from("send_queue").delete().in("lead_id", leadIds),
        supabase.from("messages").delete().in("lead_id", leadIds),
        supabase.from("flow_executions").delete().in("lead_id", leadIds),
        supabase.from("logs").delete().in("lead_id", leadIds),
      ]);

      // Reseta flags do lead
      await supabase
        .from("leads")
        .update({
          active_flow_id: null,
          active_flow_step: 0,
          flow_waiting_reply: false,
        } as any)
        .in("id", leadIds);

      setLogs([]);
      addLog(`Teste resetado para ${leadIds.length} lead(s). Pode rodar de novo.`, "success");
      toast.success("Histórico do teste limpo.");
    } catch (e: any) {
      addLog(`Erro ao resetar: ${e?.message || e}`, "error");
      toast.error("Erro ao resetar o teste.");
    } finally {
      setIsResetting(false);
    }
  };

  const runTest = async () => {
    // Proteção absoluta contra exceções que derrubam a página
    try {
      setHasInternalError(false);

      // LOG VISUAL OBRIGATÓRIO PARA CONFIRMAÇÃO DE ARQUIVO
      addLog("DEBUG FRONTEND ATIVO - SafeFlowTestModal correto", "success");

      if (!flow?.id) {
        addLog("ERRO: flow.id ausente", "error");
        toast.error("Fluxo inválido.");
        return;
      }

      const normalized = normalizePhone(phoneNumber);
      addLog(`phone normalizado: ${normalized}`, "info");

      if (!validatePhone(normalized)) {
        addLog(
          `Erro: Número de WhatsApp inválido (${normalized}). Use o formato 5537999999999`,
          "error",
        );
        toast.error("Número de WhatsApp inválido.");
        return;
      }

      setIsLoading(true);
      setLogs((prev) =>
        prev.filter((l) => l.message === "DEBUG FRONTEND ATIVO - SafeFlowTestModal correto"),
      );
      addLog("DEBUG FRONTEND ATIVO - SafeFlowTestModal correto", "success");
      addLog(`flow.id: ${flow.id}`, "info");
      addLog(`Iniciando teste seguro para o fluxo: ${flow.name}`, "info");
      addLog(`WhatsApp de destino: ${normalized}`, "info");

      // 1. Criar ou encontrar Lead de teste
      addLog("Buscando lead de teste existente...", "process");
      const { data: userData, error: authError } = await supabase.auth.getUser();

      if (authError) {
        addLog(`Falha na autenticação: ${authError.message}`, "error");
        return;
      }
      const user = userData?.user;
      if (!user) {
        addLog("Usuário não autenticado no sistema.", "error");
        return;
      }

      // Buscar lead existente manualmente de forma segura (evita erro de múltiplos resultados ou on conflict)
      const { data: leadsFound, error: searchError } = await supabase
        .from("leads")
        .select("*")
        .eq("user_id", user.id)
        .or(`phone.eq.${normalized},whatsapp.eq.${normalized}`)
        .order("created_at", { ascending: false });

      if (searchError) {
        addLog(`Aviso na busca de lead: ${searchError.message}`, "error");
      }

      // Filtro manual rigoroso para garantir que o lead pertence ao usuário e tem o telefone correto
      const existingLead = Array.isArray(leadsFound)
        ? leadsFound.find(
            (l) => l.user_id === user.id && (l.phone === normalized || l.whatsapp === normalized),
          )
        : null;

      let lead;
      if (existingLead) {
        addLog(
          `Lead de teste existente encontrado (ID: ${existingLead.id}), reutilizando o mais recente...`,
          "info",
        );
        const { data: updatedLeads, error: updateError } = await supabase
          .from("leads")
          .update({
            name: `Lead Teste - ${flow.name}`,
            source: "flow-test",
            is_test: true,
            marketing_consent_status: "not_required",
            test_expires_at: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingLead.id)
          .select();

        if (updateError) {
          addLog(`Erro ao atualizar lead: ${updateError.message}`, "error");
          return;
        }
        lead = Array.isArray(updatedLeads) && updatedLeads.length > 0 ? updatedLeads[0] : null;
      } else {
        addLog("Nenhum lead encontrado, criando novo lead de teste...", "process");
        const { data: newLeads, error: insertError } = await supabase
          .from("leads")
          .insert({
            phone: normalized,
            whatsapp: normalized,
            name: `Lead Teste - ${flow.name}`,
            source: "flow-test",
            is_test: true,
            marketing_consent_status: "not_required",
            test_expires_at: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
            user_id: user.id,
          })
          .select();

        if (insertError) {
          addLog(`Erro ao criar lead: ${insertError.message}`, "error");
          return;
        }
        lead = Array.isArray(newLeads) && newLeads.length > 0 ? newLeads[0] : null;
        if (lead) addLog("Lead criado com sucesso", "success");
      }

      if (!lead?.id) {
        addLog("Lead de teste não pôde ser processado ou retornado.", "error");
        return;
      }
      addLog(`Lead de teste pronto: ${lead.id}`, "success");

      // Cada teste começa limpo — o mesmo que o botão de limpar faz. Sem isto,
      // rodar de novo o mesmo fluxo com o mesmo lead batia na trava de duplicata
      // da fila: a mensagem que o lead já tinha recebido não saía de novo, e o
      // motor devolvia erro. O lead aqui já está marcado como teste (is_test).
      addLog("Limpando o histórico do lead de teste...", "process");
      await Promise.all([
        supabase.from("send_queue").delete().eq("lead_id", lead.id),
        supabase.from("messages").delete().eq("lead_id", lead.id),
        supabase.from("flow_executions").delete().eq("lead_id", lead.id),
      ]);
      await supabase
        .from("leads")
        .update({ active_flow_id: null, active_flow_step: 0, flow_waiting_reply: false } as any)
        .eq("id", lead.id);

      // 2. Iniciar execução do fluxo
      addLog("Criando nova execução de teste...", "process");
      const { data: executions, error: execError } = await supabase
        .from("flow_executions")
        .insert({
          flow_id: flow.id,
          lead_id: lead.id,
          status: "running",
          current_block_id: null,
          is_test: true,
          user_id: user.id,
        } as any)
        .select();

      if (execError) {
        addLog(`Erro ao criar execução: ${execError.message}`, "error");
        return;
      }
      const execution = Array.isArray(executions) && executions.length > 0 ? executions[0] : null;

      // LOGS DE DIAGNÓSTICO OBRIGATÓRIOS ANTES DA CHAMADA
      addLog(`flow_id que será enviado: ${flow?.id}`, "info");
      addLog(`lead_id que será enviado: ${lead?.id}`, "info");
      addLog(`execution_id que será enviado: ${execution?.id}`, "info");
      addLog(`phone que será enviado: ${normalized}`, "info");

      // VALIDAÇÃO PRÉ-CHAMADA RIGOROSA
      if (!flow?.id) {
        addLog("ERRO: campo obrigatório ausente antes de chamar execute-flow: flow_id", "error");
        setIsLoading(false);
        return;
      }
      if (!lead?.id) {
        addLog("ERRO: campo obrigatório ausente antes de chamar execute-flow: lead_id", "error");
        setIsLoading(false);
        return;
      }
      if (!execution?.id) {
        addLog(
          "ERRO: campo obrigatório ausente antes de chamar execute-flow: execution_id",
          "error",
        );
        setIsLoading(false);
        return;
      }
      if (!normalized) {
        addLog("ERRO: campo obrigatório ausente antes de chamar execute-flow: phone", "error");
        setIsLoading(false);
        return;
      }

      const payload = {
        flow_id: flow.id,
        lead_id: lead.id,
        execution_id: execution.id,
        phone: normalized,
        is_test: true,
        user_id: user.id,
        trigger_type: "manual",
      };

      addLog(`payload execute-flow: ${JSON.stringify(payload)}`, "info");
      addLog("Acionando motor do fluxo (Edge Function)...", "process");
      addLog(JSON.stringify(payload, null, 2), "info");

      addLog(`flow_id enviado: ${payload.flow_id}`, "info");
      addLog(`lead_id enviado: ${payload.lead_id}`, "info");
      addLog(`execution_id enviado: ${payload.execution_id}`, "info");
      addLog(`phone enviado: ${payload.phone}`, "info");

      const { data, error: flowFuncError } = await supabase.functions.invoke("execute-flow", {
        body: payload,
      });

      addLog(`Data retornado: ${JSON.stringify(data)}`, data?.success ? "success" : "info");
      addLog(`Error retornado: ${JSON.stringify(flowFuncError)}`, flowFuncError ? "error" : "info");

      if (flowFuncError) {
        let detailedError = "Erro desconhecido";

        // Tenta capturar o corpo do erro retornado pela Edge Function
        if (flowFuncError instanceof Error) {
          detailedError = flowFuncError.message;
        }

        // Em muitos casos, o erro da Edge Function (status != 2xx) vem com detalhes no objeto de erro
        // No Supabase SDK, se a função retorna 4xx/5xx, o 'data' pode ser nulo e o 'error' contém a mensagem.
        // Se houver um corpo JSON no erro, tentamos mostrar.
        addLog(`DETALHES DO ERRO: ${detailedError}`, "error");

        // Se o erro for o genérico do SDK, avisamos que o log acima tem o real se a função retornou JSON
        if (detailedError.includes("non-2xx status code") && data) {
          addLog("O servidor retornou um erro estruturado (veja 'Data retornado' acima)", "error");
        }

        addLog(`Motor do fluxo falhou: ${detailedError}`, "error");
        return;
      }

      addLog(`Sucesso: ${JSON.stringify(data)}`, "success");
      addLog("Bloco inicial processado com sucesso.", "success");

      // 4. Verificar se algo foi pra fila
      addLog("Buscando mensagem M1 na fila de envio...", "process");
      const { data: queueItems, error: queueError } = await supabase
        .from("send_queue")
        .select("*")
        .eq("lead_id", lead.id)
        .eq("flow_id", flow.id)
        .order("created_at", { ascending: false });

      if (queueError) {
        addLog(`Aviso ao ler fila: ${queueError.message}`, "error");
      }

      if (queueItems && queueItems.length > 0) {
        const item = queueItems[0];
        addLog(`Item M1 encontrado na fila (ID: ${item.id}, Status: ${item.status})`, "success");

        // 5. Forçar processamento imediato se ainda não enviado
        if (item.status === "pending" || item.status === "scheduled") {
          addLog(`ID item fila: ${item.id}`, "info");
          const processPayload = { queueItemId: item.id };
          addLog(`Payload process-queue: ${JSON.stringify(processPayload)}`, "info");
          addLog("Iniciando processamento de envio imediato...", "process");

          const { data: procResult, error: processError } = await supabase.functions.invoke(
            "process-queue",
            {
              body: processPayload,
            },
          );

          // O `execute-flow` já despacha o item na hora quando é teste, então ele
          // pode ter sido enviado entre a leitura acima e esta chamada. Nesse caso
          // o `process-queue` responde `queue_item_not_found`, que aqui não é
          // falha: é corrida. Quem decide é o status do item no banco.
          if (procResult?.step === "queue_item_not_found") {
            const { data: jaProcessado } = await supabase
              .from("send_queue")
              .select("status")
              .eq("id", item.id)
              .maybeSingle();
            if (jaProcessado?.status === "sent") {
              addLog("MENSAGEM ENVIADA! Verifique seu WhatsApp.", "success");
              toast.success("Mensagem de teste enviada!");
              return;
            }
            addLog(
              `Item não estava mais pendente (status: ${jaProcessado?.status ?? "inexistente"}).`,
              "error",
            );
          }

          if (processError || (procResult && procResult.success === false)) {
            const errorBody = processError || procResult;
            addLog(`FALHA NO ENVIO (process-queue)`, "error");
            addLog(`Status: ${processError ? "Erro de Rede/SDK" : "Erro da Função"}`, "error");
            addLog(`queueItemId: ${item.id}`, "error");
            addLog(`Body Retornado: ${JSON.stringify(errorBody, null, 2)}`, "error");

            if (errorBody?.step) addLog(`Etapa da falha: ${errorBody.step}`, "error");
            if (errorBody?.message) addLog(`Mensagem do erro: ${errorBody.message}`, "error");
            if (errorBody?.provider_response)
              addLog(
                `Resposta do provedor: ${JSON.stringify(errorBody.provider_response)}`,
                "error",
              );

            toast.error("Erro ao enviar mensagem. Veja o log.");
            return;
          } else {
            addLog(`Sucesso no process-queue: ${JSON.stringify(procResult)}`, "success");

            // Verificar status final no banco
            const { data: updatedItem } = await supabase
              .from("send_queue")
              .select("status")
              .eq("id", item.id)
              .maybeSingle();

            if (updatedItem?.status === "sent") {
              addLog("MENSAGEM ENVIADA! Verifique seu WhatsApp.", "success");
              toast.success("Mensagem de teste enviada!");
            } else {
              addLog(`Status final na fila: ${updatedItem?.status || "desconhecido"}`, "info");
            }
          }
        } else if (item.status === "sent") {
          addLog("A mensagem M1 já consta como enviada.", "success");
        } else {
          addLog(`A mensagem M1 está com status: ${item.status}`, "info");
        }
      } else {
        addLog(
          "Nenhuma mensagem gerada. Verifique se o fluxo tem um bloco 'Enviar Mensagem' conectado ao gatilho.",
          "error",
        );
      }

      // 6. Verificar estado da execução
      const { data: finalExec } = await supabase
        .from("flow_executions")
        .select("status, current_block_id")
        .eq("id", execution.id)
        .maybeSingle();

      if (finalExec?.status === "waiting_response") {
        addLog("FLUXO EM PAUSA: Aguardando sua resposta no WhatsApp para continuar.", "info");
        addLog("Para testar M2/M3: Responda qualquer coisa no WhatsApp agora.", "success");
      } else if (finalExec?.status === "completed") {
        addLog("FLUXO FINALIZADO: O fluxo chegou ao fim sem aguardar resposta.", "info");
      }
    } catch (err: any) {
      console.error("EXCEÇÃO CAPTURADA NO MODAL:", err);
      const errorMsg = err?.message || "Ocorreu um erro inesperado durante o teste.";
      addLog(`ERRO CRÍTICO: ${errorMsg}`, "error");
      toast.error("O teste falhou. Veja os logs.");
    } finally {
      setIsLoading(false);
    }
  };

  if (hasInternalError) {
    return (
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="bg-[#0f0f13] border-[#2a2a3a] text-white">
          <div className="p-6 text-center space-y-4">
            <AlertCircle className="h-12 w-12 text-red-500 mx-auto" />
            <h2 className="text-xl font-bold">Erro Interno no Modal</h2>
            <p className="text-sm text-gray-400">
              Um erro inesperado impediu o carregamento do modal de teste.
            </p>
            <Button onClick={onClose} className="w-full">
              Fechar
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(val) => !val && onClose()}>
      <DialogContent className="sm:max-w-[500px] bg-[#0f0f13] border-[#2a2a3a] text-white overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Beaker className="h-5 w-5 text-[#7c3aed]" />
            Testar Fluxo (Modo Seguro)
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="space-y-2">
            <Label className="text-[#94a3b8]">Fluxo selecionado</Label>
            <div className="p-3 rounded-lg bg-[#1a1a24] border border-[#2a2a3a] font-medium truncate">
              {safeText(flow?.name) || "Nenhum fluxo selecionado"}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="phone" className="text-[#94a3b8]">
              Seu WhatsApp de teste
            </Label>
            <div className="flex gap-2">
              <Input
                id="phone"
                placeholder="5537999999999"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                className="bg-[#1a1a24] border-[#2a2a3a] focus:ring-[#7c3aed]"
                disabled={isLoading}
              />
              <Button
                onClick={() => {
                  // Previne chamadas diretas que podem quebrar o handler
                  void runTest();
                }}
                disabled={isLoading || !phoneNumber}
                className="bg-[#7c3aed] hover:bg-[#6d28d9] min-w-[120px]"
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <PlayCircle className="h-4 w-4 mr-2" />
                )}
                Executar
              </Button>
            </div>
            <p className="text-[10px] text-[#64748b]">
              Exemplo: 55 DDD NÚMERO (sem espaços ou traços)
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-[#94a3b8]">Histórico de Processamento</Label>
            <ScrollArea className="h-[200px] w-full rounded-md border border-[#2a2a3a] bg-[#09090b] p-4">
              {logs.length === 0 ? (
                <div className="h-full flex items-center justify-center text-[#475569] text-sm italic">
                  Pronto para iniciar o teste...
                </div>
              ) : (
                <div className="space-y-3">
                  {logs.map((log, i) => (
                    <div
                      key={i}
                      className="text-xs font-mono flex gap-2 border-b border-[#1a1a24] pb-1 last:border-0"
                    >
                      <span className="text-[#475569] shrink-0">[{log.timestamp}]</span>
                      <span
                        className={
                          log.type === "success"
                            ? "text-emerald-400"
                            : log.type === "error"
                              ? "text-red-400 font-bold"
                              : log.type === "process"
                                ? "text-blue-400"
                                : "text-[#94a3b8]"
                        }
                      >
                        {log.type === "success" && (
                          <CheckCircle2 className="inline h-3 w-3 mr-1 mb-0.5" />
                        )}
                        {log.type === "error" && (
                          <AlertCircle className="inline h-3 w-3 mr-1 mb-0.5" />
                        )}
                        {log.type === "process" && (
                          <Loader2 className="inline h-3 w-3 mr-1 mb-0.5 animate-spin" />
                        )}
                        {safeText(log.message)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        </div>

        <DialogFooter className="border-t border-[#2a2a3a] pt-4 gap-2">
          <Button
            variant="outline"
            onClick={() => {
              if (
                !window.confirm(
                  "Limpar todo o histórico de teste (fila, mensagens, execuções e logs) deste número?",
                )
              )
                return;
              void resetTest();
            }}
            disabled={isLoading || isResetting || !phoneNumber}
            className="border-[#2a2a3a] text-yellow-400 hover:text-yellow-300 hover:bg-yellow-900/10"
          >
            {isResetting ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <RotateCcw className="h-4 w-4 mr-2" />
            )}
            Resetar teste
          </Button>
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={isLoading || isResetting}
            className="text-[#94a3b8] hover:text-white hover:bg-white/5"
          >
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
