import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Database,
  Loader2,
  MessageSquare,
  RefreshCw,
  Webhook,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface DiagnosticLog {
  timestamp: string;
  message: string;
  type: "info" | "success" | "error" | "warning";
}

export default function DiagnosticsPage() {
  const [logs, setLogs] = useState<DiagnosticLog[]>([]);
  const [isLoading, setIsLoading] = useState<string | null>(null);

  const addLog = (message: string, type: DiagnosticLog["type"] = "info") => {
    setLogs((previous) => [
      { timestamp: new Date().toLocaleTimeString(), message, type },
      ...previous,
    ]);
  };

  const runCheck = async (name: string, action: () => Promise<void>) => {
    setIsLoading(name);
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog(`Erro: ${message}`, "error");
    } finally {
      setIsLoading(null);
    }
  };

  const testWhatsAppConnection = () =>
    runCheck("whatsapp", async () => {
      addLog("Consultando a Graph API da Meta pelo backend...");
      const { data, error } = await supabase.functions.invoke("meta-whatsapp-admin", {
        body: { action: "diagnose" },
      });
      if (error) throw error;
      const state = data?.state;
      if (!state?.configured) {
        addLog("WhatsApp oficial ainda não configurado para esta conta.", "warning");
        return;
      }
      if (state.checks.connection !== "ok") {
        addLog(
          `A Meta recusou a conexão: ${state.error?.message ?? "motivo não informado"}`,
          "error",
        );
        return;
      }
      addLog(
        state.checks.phoneNumber === "ok"
          ? `Número ${state.phoneNumber?.displayPhoneNumber ?? "sem rótulo"} confirmado pela Meta.`
          : "Token válido, mas nenhum número foi confirmado.",
        state.checks.phoneNumber === "ok" ? "success" : "warning",
      );
    });

  const checkWebhookConfiguration = () =>
    runCheck("webhook-config", async () => {
      addLog("Verificando a inscrição do app na WABA...");
      const { data, error } = await supabase.functions.invoke("meta-whatsapp-admin", {
        body: { action: "diagnose" },
      });
      if (error) throw error;
      const state = data?.state;
      if (!state?.configured) {
        addLog("Sem credenciais gravadas: não há webhook para verificar.", "warning");
        return;
      }
      addLog(
        state.checks.webhook === "ok"
          ? "App inscrito nos webhooks da WABA."
          : "App não aparece entre os inscritos na WABA: mensagens recebidas não chegam.",
        state.checks.webhook === "ok" ? "success" : "warning",
      );
    });

  const checkQueue = () =>
    runCheck("queue", async () => {
      addLog("Consultando o estado da fila, sem disparar mensagens...");
      const [pending, sending, failed] = await Promise.all([
        supabase
          .from("send_queue")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
        supabase
          .from("send_queue")
          .select("id", { count: "exact", head: true })
          .eq("status", "sending"),
        supabase
          .from("send_queue")
          .select("id", { count: "exact", head: true })
          .eq("status", "failed"),
      ]);
      if (pending.error || sending.error || failed.error) {
        throw pending.error || sending.error || failed.error;
      }
      addLog(
        `Fila: ${pending.count || 0} pendente(s), ${sending.count || 0} em processamento e ${failed.count || 0} com falha.`,
        (failed.count || 0) > 0 ? "warning" : "success",
      );
    });

  const checkInboundWebhook = () =>
    runCheck("inbound", async () => {
      addLog("Buscando eventos de mensagens recebidas...");
      const { count, error } = await supabase
        .from("logs")
        .select("id", { count: "exact", head: true })
        .eq("event", "message_received");
      if (error) throw error;
      addLog(
        count
          ? `${count} evento(s) de mensagem recebida disponível(is).`
          : "Nenhuma mensagem recebida registrada ainda.",
        count ? "success" : "warning",
      );
    });

  const checkFlowExecutions = () =>
    runCheck("executions", async () => {
      addLog("Verificando execuções de fluxo recentes...");
      const { data, error } = await supabase
        .from("flow_executions")
        .select("status")
        .order("created_at", { ascending: false })
        .limit(25);
      if (error) throw error;
      const total = data?.length || 0;
      const running = data?.filter((execution) => execution.status === "running").length || 0;
      const waiting =
        data?.filter((execution) => execution.status === "waiting_response").length || 0;
      addLog(
        `${total} execução(ões) recente(s): ${running} em andamento e ${waiting} aguardando resposta.`,
        "success",
      );
    });

  const busy = (name: string) => isLoading === name;

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            <Activity className="h-8 w-8 text-[#7c3aed]" />
            Diagnóstico do Sistema
          </h1>
          <p className="text-[#64748b]">
            Verificações seguras: nenhuma delas envia mensagens ou altera a fila.
          </p>
        </div>
        <Button variant="outline" onClick={() => setLogs([])} className="border-[#2a2a3a]">
          Limpar logs
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        <Card className="border-[#2a2a3a] bg-[#0f0f13]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <RefreshCw className="h-4 w-4 text-blue-400" /> WhatsApp oficial
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              className="w-full justify-start"
              variant="outline"
              onClick={testWhatsAppConnection}
              disabled={!!isLoading}
            >
              {busy("whatsapp") ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Database className="mr-2 h-4 w-4" />
              )}
              Ler estado da conexão
            </Button>
            <Button
              className="w-full justify-start"
              variant="outline"
              onClick={checkWebhookConfiguration}
              disabled={!!isLoading}
            >
              {busy("webhook-config") ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Webhook className="mr-2 h-4 w-4" />
              )}
              Verificar callback protegido
            </Button>
          </CardContent>
        </Card>

        <Card className="border-[#2a2a3a] bg-[#0f0f13]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <MessageSquare className="h-4 w-4 text-emerald-400" /> Fila de envio
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              className="w-full justify-start"
              variant="outline"
              onClick={checkQueue}
              disabled={!!isLoading}
            >
              {busy("queue") ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <MessageSquare className="mr-2 h-4 w-4" />
              )}
              Verificar estado da fila
            </Button>
            <p className="text-xs text-[#94a3b8]">
              Para enviar, use um fluxo aprovado e a tela Fila. O diagnóstico nunca faz envio
              direto.
            </p>
          </CardContent>
        </Card>

        <Card className="border-[#2a2a3a] bg-[#0f0f13]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Webhook className="h-4 w-4 text-purple-400" /> Fluxos e recebimento
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              className="w-full justify-start"
              variant="outline"
              onClick={checkInboundWebhook}
              disabled={!!isLoading}
            >
              {busy("inbound") ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Webhook className="mr-2 h-4 w-4" />
              )}
              Verificar mensagens recebidas
            </Button>
            <Button
              className="w-full justify-start"
              variant="outline"
              onClick={checkFlowExecutions}
              disabled={!!isLoading}
            >
              {busy("executions") ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Activity className="mr-2 h-4 w-4" />
              )}
              Ver execuções de fluxo
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="border-[#2a2a3a] bg-[#09090b]">
        <CardHeader className="border-b border-[#2a2a3a]">
          <CardTitle className="text-md">Logs de diagnóstico</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[400px] w-full p-4">
            {logs.length === 0 ? (
              <div className="flex h-full items-center justify-center italic text-gray-500">
                Aguardando uma verificação...
              </div>
            ) : (
              <div className="space-y-2">
                {logs.map((log, index) => (
                  <div
                    key={`${log.timestamp}-${index}`}
                    className="flex gap-2 border-b border-[#1a1a24] pb-2 font-mono text-xs last:border-0"
                  >
                    <span className="shrink-0 text-gray-500">[{log.timestamp}]</span>
                    <span
                      className={
                        log.type === "success"
                          ? "text-emerald-400"
                          : log.type === "error"
                            ? "font-bold text-red-400"
                            : log.type === "warning"
                              ? "text-amber-400"
                              : "text-gray-300"
                      }
                    >
                      {log.type === "success" && <CheckCircle2 className="mr-1 inline h-3 w-3" />}
                      {log.type === "error" && <AlertCircle className="mr-1 inline h-3 w-3" />}
                      {log.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
