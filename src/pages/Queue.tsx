import { useQueue, useQueueStats, useReprocessFailed } from "@/hooks/use-queue";
import { useAccount, useUpdateAccount } from "@/hooks/use-crm";
import { supabase } from "@/integrations/supabase/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  RefreshCw,
  Send,
  CheckCircle,
  AlertCircle,
  Clock,
  Loader2,
  Play,
  Pause,
  Terminal,
  Hand,
} from "lucide-react";
import { useState, useEffect, useCallback, useRef } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { safeText } from "@/lib/utils/safeData";
import { toast } from "sonner";
import { processQueueBatch } from "@/services/queueService";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function QueuePage() {
  const [statusFilter, setStatusFilter] = useState("all");
  const { data: queue, isLoading, refetch } = useQueue(statusFilter);
  const { data: stats } = useQueueStats();
  const reprocess = useReprocessFailed();
  const { data: account } = useAccount();
  const updateAccount = useUpdateAccount();

  // Settings (envio manual / janela de horário)
  const accountSettings = (account?.settings as any) || {};
  const [manualOnly, setManualOnly] = useState<boolean>(false);
  const [paused, setPaused] = useState<boolean>(false);
  const [startHour, setStartHour] = useState<string>("08:00");
  const [endHour, setEndHour] = useState<string>("17:00");
  const [dailyLimit, setDailyLimit] = useState<number>(40);
  const [intervalMinutes, setIntervalMinutes] = useState<number>(4);
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5]);

  useEffect(() => {
    if (account?.settings) {
      const s: any = account.settings;
      setManualOnly(!!s.manual_send_only);
      setPaused(!!s.paused);
      const sh = s.start_hour ?? 8;
      const eh = s.end_hour ?? 18;
      setStartHour(`${String(sh).padStart(2, "0")}:00`);
      setEndHour(`${String(eh).padStart(2, "0")}:00`);
      setDailyLimit(Number(s.daily_limit ?? 40));
      setIntervalMinutes(Number(s.send_interval_minutes ?? 4));
      setSelectedDays(Array.isArray(s.days) ? s.days : [1, 2, 3, 4, 5]);
    }
  }, [account]);

  const reschedulePending = async (settings: any) => {
    const sh = Number(settings.start_hour ?? 8);
    const eh = Number(settings.end_hour ?? 18);
    const dailyCap = Math.max(1, Number(settings.daily_limit ?? 40));
    const intervalMs = Math.max(0, Number(settings.send_interval_minutes ?? 0)) * 60000;
    const days: number[] =
      Array.isArray(settings.days) && settings.days.length > 0 ? settings.days : [1, 2, 3, 4, 5];

    const { data: userData } = await supabase.auth.getUser();
    if (!userData?.user) return;

    const { data: pending } = await supabase
      .from("send_queue")
      .select("id, scheduled_at, created_at")
      .eq("user_id", userData.user.id)
      .eq("status", "pending")
      .order("scheduled_at", { ascending: true });

    if (!pending || pending.length === 0) return;

    // Trabalha com horário de Brasília (UTC-3)
    const BR_OFFSET_MS = 3 * 3600 * 1000;
    const toBR = (d: Date) => new Date(d.getTime() - BR_OFFSET_MS);
    const fromBR = (d: Date) => new Date(d.getTime() + BR_OFFSET_MS);

    const nowBR = toBR(new Date());
    let cursor = new Date(nowBR);
    // Se antes do início do dia, move pro início; se depois do fim, próximo dia
    if (cursor.getUTCHours() < sh) {
      cursor.setUTCHours(sh, 0, 0, 0);
    } else if (cursor.getUTCHours() >= eh) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(sh, 0, 0, 0);
    }
    while (!days.includes(cursor.getUTCDay())) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(sh, 0, 0, 0);
    }

    let sentToday = 0;
    let currentDay = cursor.getUTCDate();
    const updates: { id: string; scheduled_at: string }[] = [];

    for (const item of pending) {
      // Verifica limite diário e janela
      if (cursor.getUTCDate() !== currentDay) {
        sentToday = 0;
        currentDay = cursor.getUTCDate();
      }
      if (sentToday >= dailyCap || cursor.getUTCHours() >= eh) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        cursor.setUTCHours(sh, 0, 0, 0);
        sentToday = 0;
        currentDay = cursor.getUTCDate();
      }
      while (!days.includes(cursor.getUTCDay())) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        cursor.setUTCHours(sh, 0, 0, 0);
        sentToday = 0;
        currentDay = cursor.getUTCDate();
      }

      updates.push({ id: item.id, scheduled_at: fromBR(cursor).toISOString() });
      sentToday++;
      cursor = new Date(cursor.getTime() + (intervalMs || 60000));
    }

    // Aplica updates em paralelo (lotes)
    for (const u of updates) {
      await supabase.from("send_queue").update({ scheduled_at: u.scheduled_at }).eq("id", u.id);
    }
    return updates.length;
  };

  const saveScheduleSettings = async (
    overrides: Partial<{ paused: boolean; manual_send_only: boolean }> = {},
  ) => {
    const sh = parseInt(startHour.split(":")[0] || "8", 10);
    const eh = parseInt(endHour.split(":")[0] || "17", 10);
    const limit = Math.max(1, Math.min(10000, Number(dailyLimit) || 40));
    const interval = Math.max(0, Math.min(1440, Number(intervalMinutes) || 0));
    const days =
      selectedDays.length > 0 ? [...selectedDays].sort((a, b) => a - b) : [1, 2, 3, 4, 5];
    const next = {
      ...(accountSettings || {}),
      manual_send_only: overrides.manual_send_only ?? manualOnly,
      paused: overrides.paused ?? paused,
      start_hour: isNaN(sh) ? 8 : sh,
      end_hour: isNaN(eh) ? 18 : eh,
      daily_limit: limit,
      send_interval_minutes: interval,
      days,
      respect_business_hours: true,
    };
    try {
      await updateAccount.mutateAsync({ settings: next });
      const count = await reschedulePending(next);
      if (count && count > 0) {
        toast.success(`Fila reagendada: ${count} mensagens atualizadas.`);
      }
      refetch();
    } catch (e: any) {
      console.error("[Queue] saveScheduleSettings:", e);
    }
  };

  const toggleDay = (day: number) => {
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );
  };

  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    saveScheduleSettings({ paused: next });
    toast.success(next ? "Envios pausados" : "Envios retomados");
  };

  // Estados para processamento da fila
  const [isProcessing, setIsProcessing] = useState(false);
  const [logs, setLogs] = useState<
    { msg: string; type: "info" | "success" | "error" | "warning"; time: Date }[]
  >([]);
  const processingRef = useRef(false);

  const addLog = useCallback(
    (msg: string, type: "info" | "success" | "error" | "warning" = "info") => {
      setLogs((prev) => [{ msg, type, time: new Date() }, ...prev].slice(0, 50));
      console.log(`[QueueLog] ${msg}`);
    },
    [],
  );

  const processQueue = useCallback(
    async (batchSize: number = 5) => {
      if (processingRef.current) return;

      try {
        processingRef.current = true;
        setIsProcessing(true);
        addLog("Iniciando processamento da fila...", "info");

        const result = await processQueueBatch(batchSize);

        if (result.processed > 0) {
          addLog(`${result.processed} mensagens enviadas com sucesso.`, "success");
        }

        if (result.failed > 0) {
          addLog(`${result.failed} mensagens falharam.`, "error");
        }

        if (result.processed === 0 && result.failed === 0) {
          const reason = (result as any).skipped;
          const map: Record<string, string> = {
            paused: "Envios pausados.",
            manual_only: "Modo manual ativo. O job não enviará itens automaticamente.",
            out_of_window: "Fora da janela de horário (Brasília).",
            disconnected: "WhatsApp desconectado.",
          };
          addLog(
            reason
              ? map[reason] || `Ignorado: ${reason}`
              : "Nenhum item pendente encontrado para processar agora.",
            reason ? "warning" : "info",
          );
        }

        if (result.processed > 0 || result.failed > 0) {
          toast.success(`${result.processed} enviados, ${result.failed} falhas.`);
          refetch();
        }
      } catch (error: any) {
        addLog(`Erro no processamento: ${error.message}`, "error");
        toast.error(`Erro na fila: ${error.message}`);
      } finally {
        setIsProcessing(false);
        processingRef.current = false;
      }
    },
    [addLog, refetch],
  );

  // Intervalo automático a cada 30 segundos (desativado em modo manual)
  useEffect(() => {
    if (manualOnly || paused) return;
    const interval = setInterval(() => {
      if (!processingRef.current) {
        processQueue(5);
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [processQueue, manualOnly, paused]);

  const getStatusBadge = (status: string | null) => {
    switch (status) {
      case "sent":
        return <Badge variant="success">Enviado</Badge>;
      case "failed":
        return <Badge variant="destructive">Falhou</Badge>;
      case "sending":
        return (
          <Badge
            variant="default"
            className="bg-[#3b82f620] text-[#3b82f6] border-none animate-pulse"
          >
            Enviando
          </Badge>
        );
      default:
        return <Badge variant="warning">Pendente</Badge>;
    }
  };

  if (isLoading) return <div className="p-8 text-center">Carregando fila...</div>;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Fila de Envio</h1>
          <p className="text-[#64748b]">Acompanhe o status das mensagens em tempo real</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={paused ? "default" : "outline"}
            size="sm"
            onClick={togglePause}
            className={
              paused
                ? "bg-red-600 hover:bg-red-500 text-white"
                : "border-[#2a2a2a] text-yellow-400 hover:text-yellow-300 hover:bg-yellow-900/10"
            }
          >
            {paused ? <Play className="h-4 w-4 mr-2" /> : <Pause className="h-4 w-4 mr-2" />}
            {paused ? "Retomar envios" : "Pausar envios"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              if (!window.confirm("Agendar todos os leads em Prospecção para envio?")) return;
              try {
                const { data: userData } = await supabase.auth.getUser();
                if (!userData?.user) {
                  toast.error("Usuário não autenticado.");
                  return;
                }

                const { data: stages } = await supabase
                  .from("pipeline_stages")
                  .select("id")
                  .eq("name", "Prospecção");
                if (!stages || stages.length === 0) {
                  toast.error("Nenhuma etapa de Prospecção encontrada.");
                  return;
                }
                const stageIds = (Array.isArray(stages) ? stages : []).map((s) => s.id);

                const { data: leads } = await supabase
                  .from("leads")
                  .select("*")
                  .in("stage_id", stageIds);
                if (!leads || leads.length === 0) {
                  toast.info("Nenhum lead encontrado em Prospecção.");
                  return;
                }

                const validLeads = (Array.isArray(leads) ? leads : []).filter(
                  (l) => l?.phone && String(l.phone).trim() !== "",
                );
                if (validLeads.length === 0) {
                  toast.info("Nenhum lead em Prospecção possui telefone cadastrado.");
                  return;
                }

                const { data: existingQueue } = await supabase.from("send_queue").select("lead_id");
                const existingIds = new Set(existingQueue?.map((q) => q.lead_id) || []);

                const toSchedule = validLeads.filter((l) => !existingIds.has(l.id));
                if (toSchedule.length === 0) {
                  toast.info("Todos os leads já estão na fila.");
                  return;
                }

                let { data: flow } = await supabase
                  .from("flows")
                  .select("id")
                  .eq("user_id", userData.user.id)
                  .limit(1)
                  .single();
                if (!flow) {
                  const { data: firstFlow } = await supabase
                    .from("flows")
                    .select("id")
                    .limit(1)
                    .single();
                  flow = firstFlow;
                }
                if (!flow?.id) {
                  toast.error("Nenhum fluxo disponível para agendar.");
                  return;
                }

                const { data: block } = await supabase
                  .from("flow_blocks")
                  .select("id")
                  .eq("flow_id", flow.id)
                  .eq("type", "message")
                  .order("position", { ascending: true })
                  .limit(1)
                  .single();

                const { data: lastQueue } = await supabase
                  .from("send_queue")
                  .select("scheduled_at")
                  .eq("status", "pending")
                  .order("scheduled_at", { ascending: false })
                  .limit(1);
                const baseTime = lastQueue?.[0]?.scheduled_at
                  ? new Date(lastQueue[0].scheduled_at)
                  : new Date();

                const intervalMs = Math.max(0, Number(intervalMinutes) || 0) * 60000;
                const queueData = toSchedule.map((lead, idx) => {
                  const scheduledAt = new Date(
                    baseTime.getTime() + (idx + 1) * (intervalMs || 60000),
                  );
                  return {
                    user_id: userData.user.id,
                    lead_id: lead.id,
                    flow_id: flow.id,
                    block_id: block?.id,
                    status: "pending",
                    scheduled_at: scheduledAt.toISOString(),
                  };
                });

                const { error: insertError } = await supabase.from("send_queue").insert(queueData);
                if (insertError) throw insertError;

                const count = queueData.length;

                toast.success(`${count} leads agendados para envio!`);
                refetch();
              } catch (e: any) {
                console.error("[Queue] agendar prospecção falhou:", e);
                toast.error("Erro ao agendar: " + (e?.message || "falha desconhecida"));
              }
            }}
            className="border-[#2a2a2a] text-[#7c3aed] hover:bg-[#7c3aed10]"
          >
            Agendar leads da Prospecção
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => processQueue(10)}
            disabled={isProcessing}
            className="border-[#2a2a2a] text-green-400 hover:text-green-300 hover:bg-green-900/10"
          >
            {isProcessing ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Processar agora
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              try {
                refetch();
              } catch (e) {
                console.error(e);
                toast.error("Não foi possível atualizar.");
              }
            }}
            className="border-[#2a2a2a]"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Atualizar
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (!window.confirm("Reprocessar todas as mensagens com falha?")) return;
              try {
                reprocess.mutate();
              } catch (e) {
                console.error(e);
                toast.error("Não foi possível reprocessar.");
              }
            }}
            disabled={reprocess.isPending || (stats?.failed || 0) === 0 || isProcessing}
            className="border-[#2a2a2a] text-red-400 hover:text-red-300 hover:bg-red-900/10"
          >
            {reprocess.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Reprocessar Falhas
          </Button>
        </div>
      </div>

      {/* Configuração de envio */}
      <Card className="bg-[#111118] border-[#2a2a3a] text-white shadow-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Hand className="h-4 w-4 text-[#7c3aed]" />
            Configuração de Envio
          </CardTitle>
          <CardDescription className="text-[#64748b] text-xs">
            Defina o modo de envio e a janela de horário (Brasília, GMT-3)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
            <div className="flex items-center justify-between md:justify-start gap-3 p-3 rounded-lg bg-[#0d0d14] border border-[#2a2a3a]">
              <div>
                <Label className="text-sm">Envio manual</Label>
                <p className="text-[10px] text-[#64748b]">Desativa o processamento automático</p>
              </div>
              <Switch checked={manualOnly} onCheckedChange={setManualOnly} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-[#94a3b8]">Início (horário de Brasília)</Label>
              <Input
                type="time"
                value={startHour}
                onChange={(e) => setStartHour(e.target.value)}
                className="bg-[#0d0d14] border-[#2a2a3a]"
                disabled={manualOnly}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-[#94a3b8]">Fim (horário de Brasília)</Label>
              <Input
                type="time"
                value={endHour}
                onChange={(e) => setEndHour(e.target.value)}
                className="bg-[#0d0d14] border-[#2a2a3a]"
                disabled={manualOnly}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-[#94a3b8]">Máximo de mensagens por dia</Label>
              <Input
                type="number"
                min={1}
                max={10000}
                value={dailyLimit}
                onChange={(e) => setDailyLimit(Number(e.target.value))}
                className="bg-[#0d0d14] border-[#2a2a3a]"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-[#94a3b8]">Intervalo entre mensagens (min)</Label>
              <Input
                type="number"
                min={0}
                max={1440}
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                className="bg-[#0d0d14] border-[#2a2a3a]"
              />
              <p className="text-[10px] text-[#64748b]">Tempo mínimo aguardado entre cada envio</p>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            <Label className="text-xs text-[#94a3b8]">Dias da semana para envio</Label>
            <div className="flex flex-wrap gap-2">
              {[
                { d: 0, label: "Dom" },
                { d: 1, label: "Seg" },
                { d: 2, label: "Ter" },
                { d: 3, label: "Qua" },
                { d: 4, label: "Qui" },
                { d: 5, label: "Sex" },
                { d: 6, label: "Sáb" },
              ].map(({ d, label }) => {
                const active = selectedDays.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleDay(d)}
                    disabled={manualOnly}
                    className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                      active
                        ? "bg-[#7c3aed] border-[#7c3aed] text-white"
                        : "bg-[#0d0d14] border-[#2a2a3a] text-[#94a3b8] hover:border-[#7c3aed]/50"
                    } ${manualOnly ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <Button
              onClick={() => saveScheduleSettings()}
              disabled={updateAccount.isPending}
              className="bg-[#7c3aed] hover:bg-[#6d28d9] h-10"
            >
              {updateAccount.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Salvar configuração
            </Button>
          </div>
          {manualOnly && (
            <p className="text-[11px] text-yellow-400/80 mt-3">
              Modo manual ativo: o job não enviará mensagens. Use "Processar agora" para enviar
              itens já agendados.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-[#111118] border-[#2a2a3a] text-white shadow-xl group hover:border-yellow-500/30 transition-all">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-[#64748b]">Pendentes</p>
                <p className="text-2xl font-bold">{stats?.pending || 0}</p>
              </div>
              <Clock className="h-8 w-8 text-yellow-500/20" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-[#111118] border-[#2a2a2a] text-white shadow-xl group hover:border-blue-500/30 transition-all">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-[#64748b]">Enviando</p>
                <p className="text-2xl font-bold">{stats?.sending || 0}</p>
              </div>
              <Send className="h-8 w-8 text-blue-500/20" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-[#111118] border-[#2a2a2a] text-white shadow-xl group hover:border-green-500/30 transition-all">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-[#64748b]">Enviadas</p>
                <p className="text-2xl font-bold">{stats?.sent || 0}</p>
              </div>
              <CheckCircle className="h-8 w-8 text-green-500/20" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-[#111118] border-[#2a2a2a] text-white shadow-xl group hover:border-red-500/30 transition-all">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-[#64748b]">Falhas</p>
                <p className="text-2xl font-bold">{stats?.failed || 0}</p>
              </div>
              <AlertCircle className="h-8 w-8 text-red-500/20" />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="bg-[#111118] rounded-xl border border-[#2a2a3a] overflow-hidden shadow-2xl">
        <div className="p-4 border-b border-[#2a2a3a] bg-[#0d0d14]">
          <div className="flex flex-wrap gap-2">
            <Button
              variant={statusFilter === "all" ? "default" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter("all")}
              className={
                statusFilter === "all"
                  ? "bg-[#7c3aed] text-white"
                  : "text-[#475569] hover:text-white"
              }
            >
              Todos (
              {(stats?.pending || 0) +
                (stats?.sent || 0) +
                (stats?.failed || 0) +
                (stats?.sending || 0)}
              )
            </Button>
            <Button
              variant={statusFilter === "pending" ? "default" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter("pending")}
              className={
                statusFilter === "pending" ? "bg-yellow-500/20 text-yellow-500" : "text-[#64748b]"
              }
            >
              Pendente ({stats?.pending || 0})
            </Button>
            <Button
              variant={statusFilter === "sending" ? "default" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter("sending")}
              className={
                statusFilter === "sending" ? "bg-blue-500/20 text-blue-500" : "text-[#64748b]"
              }
            >
              Enviando ({stats?.sending || 0})
            </Button>
            <Button
              variant={statusFilter === "sent" ? "default" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter("sent")}
              className={
                statusFilter === "sent" ? "bg-green-500/20 text-green-500" : "text-[#64748b]"
              }
            >
              Enviado ({stats?.sent || 0})
            </Button>
            <Button
              variant={statusFilter === "failed" ? "default" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter("failed")}
              className={
                statusFilter === "failed" ? "bg-red-500/20 text-red-500" : "text-[#64748b]"
              }
            >
              Falhou ({stats?.failed || 0})
            </Button>
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="border-[#2a2a2a] hover:bg-transparent text-[11px] uppercase tracking-wider text-[#475569]">
              <TableHead>Lead</TableHead>
              <TableHead>Agendado para</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tentativas</TableHead>
              <TableHead>Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(Array.isArray(queue) ? queue : []).map((item) => (
              <TableRow key={item.id} className="border-[#2a2a2a]">
                <TableCell>
                  <div>
                    <p className="font-medium">{safeText((item.leads as any)?.name)}</p>
                    <p className="text-xs text-[#64748b]">{safeText((item.leads as any)?.phone)}</p>
                  </div>
                </TableCell>
                <TableCell className="text-sm text-[#94a3b8]">
                  {item.scheduled_at
                    ? format(new Date(item.scheduled_at), "dd/MM HH:mm:ss", { locale: ptBR })
                    : "-"}
                </TableCell>
                <TableCell>{getStatusBadge(item.status)}</TableCell>
                <TableCell className="text-sm text-[#94a3b8]">{item.attempts || 0}/3</TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      toast.info("Visualização de mensagem temporariamente indisponível.")
                    }
                    className="text-[#64748b]"
                  >
                    Ver Mensagem
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {(Array.isArray(queue) ? queue : []).length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-32 text-[#475569]">
                  <div className="flex flex-col items-center justify-center space-y-4">
                    <div className="p-6 rounded-full bg-[#111118] border border-[#2a2a3a]">
                      <Send className="h-10 w-10 opacity-10" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-white font-bold">Fila vazia</p>
                      <p className="text-xs">
                        Não há mensagens agendadas ou em processamento no momento.
                      </p>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {/* Logs de Processamento */}
      <Card className="bg-[#0d0d14] border-[#2a2a3a] text-white shadow-2xl overflow-hidden">
        <CardHeader className="py-3 px-4 border-b border-[#2a2a3a] flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-medium flex items-center gap-2 text-[#94a3b8]">
            <Terminal className="h-4 w-4" />
            Console de Processamento
          </CardTitle>
          {isProcessing && (
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-[10px] text-green-500 uppercase tracking-widest font-bold">
                Ativo
              </span>
            </div>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[200px] w-full bg-black/40">
            <div className="p-4 font-mono text-xs space-y-1">
              {logs.map((log, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-[#475569]">{format(log.time, "HH:mm:ss")}</span>
                  <span
                    className={
                      log.type === "error"
                        ? "text-red-400"
                        : log.type === "success"
                          ? "text-green-400"
                          : log.type === "warning"
                            ? "text-yellow-400"
                            : "text-blue-300"
                    }
                  >
                    {log.type === "error"
                      ? "[ERRO]"
                      : log.type === "success"
                        ? "[OK]"
                        : log.type === "warning"
                          ? "[AVISO]"
                          : "[INFO]"}{" "}
                    {log.msg}
                  </span>
                </div>
              ))}
              {logs.length === 0 && (
                <div className="text-[#475569] italic py-8 text-center">
                  Nenhum log de processamento recente.
                </div>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <div className="h-20" />
    </div>
  );
}
