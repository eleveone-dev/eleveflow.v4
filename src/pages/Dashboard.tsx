import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { handleError } from "@/utils/error-handler";
import {
  Users,
  MessageSquare,
  GitBranch,
  Clock,
  Send,
  AlertTriangle,
  ChevronRight,
  Smartphone,
  ArrowUpRight,
  ArrowDownLeft,
  Calendar as CalendarIcon,
  Heart,
  Presentation,
  FileText,
  CheckCircle2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useWhatsappConnection } from "@/hooks/use-whatsapp-connection";
import { useEvolutionConnection, useWhatsappProvider } from "@/hooks/use-evolution-connection";
import { safeText } from "@/lib/utils/safeData";
import { calculateResponseRate, countDistinctLeadsForStages } from "@/lib/marketing-metrics";

type RangePreset = "1d" | "7d" | "30d" | "custom";

function matchStage(name: string, keywords: string[]) {
  const n = (name || "").toLowerCase().trim();
  return keywords.some((k) => n.includes(k));
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { data: whatsappStatus } = useWhatsappConnection();
  // O selo tem de seguir o provedor da conta. Ele olhava só o diagnóstico da
  // Meta, então conta na Evolution aparecia desconectada aqui enquanto a tela
  // /whatsapp mostrava conectada — a mesma pergunta com duas respostas.
  const { data: whatsappProvider } = useWhatsappProvider();
  const usaEvolution = whatsappProvider === "evolution";
  const { data: evolutionState } = useEvolutionConnection({ enabled: usaEvolution });

  // "no ar" exige confirmação de agora — da Meta ou do servidor da Evolution —,
  // não um campo gravado no banco.
  const whatsappVerified = usaEvolution
    ? Boolean(evolutionState?.connected)
    : whatsappStatus?.checks.phoneNumber === "ok";
  const whatsappPartial = usaEvolution
    ? Boolean(evolutionState?.exists) && !evolutionState?.connected
    : !!whatsappStatus?.configured &&
      !whatsappVerified &&
      whatsappStatus?.checks.connection !== "failed";

  const [preset, setPreset] = useState<RangePreset>("7d");
  const [customFrom, setCustomFrom] = useState<Date | undefined>(subDays(new Date(), 7));
  const [customTo, setCustomTo] = useState<Date | undefined>(new Date());

  const { from, to } = useMemo(() => {
    const now = new Date();
    if (preset === "1d") return { from: startOfDay(now), to: endOfDay(now) };
    if (preset === "7d") return { from: startOfDay(subDays(now, 6)), to: endOfDay(now) };
    if (preset === "30d") return { from: startOfDay(subDays(now, 29)), to: endOfDay(now) };
    return {
      from: customFrom ? startOfDay(customFrom) : startOfDay(subDays(now, 6)),
      to: customTo ? endOfDay(customTo) : endOfDay(now),
    };
  }, [preset, customFrom, customTo]);

  const fromISO = from.toISOString();
  const toISO = to.toISOString();

  const { data: dashboardData, isLoading } = useQuery({
    queryKey: ["dashboard-data", fromISO, toISO],
    queryFn: async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return null;

        const [
          totalLeads,
          leadsInRange,
          messagesSentInRange,
          activeFlows,
          contactedLeads,
          responseLeads,
          pendingQueue,
          failedMessages,
          stages,
          leadsByStage,
          stageEventsInRange,
          lastMessages,
          recentLeads,
          activeExecutions,
        ] = await Promise.all([
          supabase.from("leads").select("*", { count: "exact", head: true }),
          supabase
            .from("leads")
            .select("*", { count: "exact", head: true })
            .gte("created_at", fromISO)
            .lte("created_at", toISO),
          supabase
            .from("messages")
            .select("*", { count: "exact", head: true })
            .eq("direction", "outbound")
            .eq("status", "sent")
            .gte("created_at", fromISO)
            .lte("created_at", toISO),
          supabase
            .from("flow_executions")
            .select("*", { count: "exact", head: true })
            .eq("status", "running"),
          supabase
            .from("messages")
            .select("lead_id")
            .eq("direction", "outbound")
            .eq("status", "sent")
            .gte("created_at", fromISO)
            .lte("created_at", toISO),
          supabase
            .from("messages")
            .select("lead_id")
            .eq("direction", "inbound")
            .gte("created_at", fromISO)
            .lte("created_at", toISO),
          supabase
            .from("send_queue")
            .select("*", { count: "exact", head: true })
            .eq("status", "pending"),
          supabase
            .from("messages")
            .select("*", { count: "exact", head: true })
            .eq("status", "failed"),
          supabase.from("pipeline_stages").select("*").order("position", { ascending: true }),
          supabase.from("leads").select("stage_id"),
          supabase
            .from("lead_stage_events")
            .select("lead_id, to_stage_id")
            .gte("occurred_at", fromISO)
            .lte("occurred_at", toISO),
          supabase
            .from("messages")
            .select("*, leads(name)")
            .order("created_at", { ascending: false })
            .limit(10),
          supabase
            .from("leads")
            .select("*, pipeline_stages(name), flow_executions(status)")
            .order("created_at", { ascending: false })
            .limit(5),
          supabase
            .from("flow_executions")
            .select("*, leads(name), flows(name)")
            .eq("status", "running")
            .limit(5),
        ]);

        const responseRate = calculateResponseRate(
          contactedLeads.data?.map((message) => message.lead_id) ?? [],
          responseLeads.data?.map((message) => message.lead_id) ?? [],
        );

        const stagesList = Array.isArray(stages.data) ? stages.data : [];
        const stageChartData =
          stagesList.map((stage) => ({
            name: safeText(stage.name),
            value:
              (Array.isArray(leadsByStage.data) ? leadsByStage.data : []).filter(
                (l) => l.stage_id === stage.id,
              ).length || 0,
            color: stage.color || "#7c3aed",
          })) || [];

        // Funnel counts are based on immutable stage-transition events in the selected range.
        const stageEvents = (
          Array.isArray(stageEventsInRange.data) ? stageEventsInRange.data : []
        ).map((event) => ({ leadId: event.lead_id, stageId: event.to_stage_id }));
        const countByKeywords = (keywords: string[]) => {
          const funnelKey = keywords.includes("interess")
            ? "interested"
            : keywords.includes("demo")
              ? "demo"
              : keywords.includes("proposta")
                ? "proposal"
                : keywords.includes("venda")
                  ? "won"
                  : null;
          const matchingStageIds = stagesList
            .filter(
              (stage) =>
                (funnelKey ? stage.funnel_key === funnelKey : matchStage(stage.name, keywords)) ||
                (!stage.funnel_key && matchStage(stage.name, keywords)),
            )
            .map((stage) => stage.id);
          return countDistinctLeadsForStages(stageEvents, matchingStageIds);
        };

        const funnel = {
          interessados: countByKeywords(["interess"]),
          demonstracao: countByKeywords(["demonstr", "demo"]),
          orcamento: countByKeywords(["orçament", "orcament", "proposta"]),
          fechados: countByKeywords(["fechad", "ganho", "venda"]),
        };

        return {
          metrics: {
            totalLeads: (totalLeads as any).count || 0,
            leadsInRange: (leadsInRange as any).count || 0,
            messagesSentInRange: (messagesSentInRange as any).count || 0,
            activeFlows: (activeFlows as any).count || 0,
            responseRate,
            pendingQueue: (pendingQueue as any).count || 0,
            failedMessages: (failedMessages as any).count || 0,
          },
          funnel,
          stageChartData,
          lastMessages: (lastMessages as any).data || [],
          recentLeads: (recentLeads as any).data || [],
          activeExecutions: (activeExecutions as any).data || [],
        };
      } catch (err) {
        handleError(err, "Dashboard:queryFn");
        return null;
      }
    },
    meta: { errorMessage: "Erro ao carregar dados do dashboard" },
    refetchInterval: 300000,
    staleTime: 60000,
  });

  const rangeLabel = useMemo(() => {
    if (preset === "1d") return "Hoje";
    if (preset === "7d") return "Últimos 7 dias";
    if (preset === "30d") return "Últimos 30 dias";
    return `${format(from, "dd/MM/yy", { locale: ptBR })} – ${format(to, "dd/MM/yy", { locale: ptBR })}`;
  }, [preset, from, to]);

  const metricCards = useMemo(
    () => [
      {
        title: "Total de Leads",
        value: dashboardData?.metrics?.totalLeads ?? 0,
        icon: Users,
        color: "text-[#7c3aed]",
      },
      {
        title: `Leads (${rangeLabel})`,
        value: dashboardData?.metrics?.leadsInRange ?? 0,
        icon: Clock,
        color: "text-[#3b82f6]",
      },
      {
        title: `Envios (${rangeLabel})`,
        value: dashboardData?.metrics?.messagesSentInRange ?? 0,
        icon: Send,
        color: "text-[#10b981]",
      },
      {
        title: "Fluxos ativos",
        value: dashboardData?.metrics?.activeFlows ?? 0,
        icon: GitBranch,
        color: "text-[#8b5cf6]",
      },
      {
        title: "Taxa de Resposta",
        value: `${dashboardData?.metrics?.responseRate ?? 0}%`,
        icon: MessageSquare,
        color: "text-[#f59e0b]",
      },
      {
        title: "Fila pendente",
        value: dashboardData?.metrics?.pendingQueue ?? 0,
        icon: Clock,
        color: "text-[#ef4444]",
      },
    ],
    [dashboardData, rangeLabel],
  );

  const funnelCards = useMemo(
    () => [
      {
        title: "Envios de mensagens",
        value: dashboardData?.metrics?.messagesSentInRange ?? 0,
        icon: Send,
        color: "#3b82f6",
      },
      {
        title: "Demonstraram interesse",
        value: dashboardData?.funnel?.interessados ?? 0,
        icon: Heart,
        color: "#f59e0b",
      },
      {
        title: "Em demonstração",
        value: dashboardData?.funnel?.demonstracao ?? 0,
        icon: Presentation,
        color: "#8b5cf6",
      },
      {
        title: "Receberam orçamento",
        value: dashboardData?.funnel?.orcamento ?? 0,
        icon: FileText,
        color: "#06b6d4",
      },
      {
        title: "Fecharam venda",
        value: dashboardData?.funnel?.fechados ?? 0,
        icon: CheckCircle2,
        color: "#10b981",
      },
    ],
    [dashboardData],
  );

  const getWhatsappStatusColor = () => {
    if (whatsappVerified) return "bg-green-500";
    if (whatsappPartial) return "bg-yellow-500";
    return "bg-red-500";
  };

  const getWhatsappStatusText = () => {
    if (whatsappVerified) return "Número confirmado";
    if (whatsappPartial) return "Conexão incompleta";
    return "WhatsApp não configurado";
  };

  if (isLoading) {
    return (
      <div className="space-y-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-10 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-16 w-full md:w-[280px] rounded-2xl" />
        </div>
        <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-20">
      {/* Alertas */}
      {!isLoading &&
        (!whatsappVerified ||
          (dashboardData?.metrics?.pendingQueue || 0) > 50 ||
          (dashboardData?.metrics?.failedMessages || 0) > 0) && (
          <div className="space-y-2">
            {!whatsappVerified && (
              <div className="flex items-center gap-4 p-5 bg-[#ef444408] border border-[#ef444420] rounded-2xl text-[#ef4444] shadow-lg shadow-red-500/5">
                <div className="p-2 rounded-xl bg-[#ef444410]">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div className="flex-1 text-sm font-bold tracking-tight">
                  WhatsApp sem número confirmado. Os envios ficam parados.
                </div>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => navigate({ to: "/whatsapp" as any })}
                  className="font-bold rounded-lg shadow-lg shadow-red-500/20"
                >
                  Conectar agora
                </Button>
              </div>
            )}
            {(dashboardData?.metrics.failedMessages || 0) > 0 && (
              <div className="flex items-center gap-4 p-5 bg-[#f59e0b08] border border-[#f59e0b20] rounded-2xl text-[#f59e0b] shadow-lg shadow-yellow-500/5">
                <div className="p-2 rounded-xl bg-[#f59e0b10]">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div className="flex-1 text-sm font-bold tracking-tight">
                  Existem {dashboardData?.metrics.failedMessages} mensagens com erro na fila.
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-[#f59e0b20] text-[#f59e0b] hover:bg-[#f59e0b10] font-bold rounded-lg"
                  onClick={() => navigate({ to: "/queue" })}
                >
                  Ver fila
                </Button>
              </div>
            )}
          </div>
        )}

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Dashboard</h1>
          <p className="text-sm text-[#475569] font-medium mt-1">
            Visão geral e métricas de desempenho em tempo real.
          </p>
        </div>

        <Card className="bg-[#111118] border-[#2a2a3a] w-full md:w-auto min-w-[280px] shadow-2xl">
          <CardContent className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="relative">
                <div
                  className={`h-3 w-3 rounded-full ${getWhatsappStatusColor()} ${whatsappPartial ? "animate-pulse" : ""} shadow-[0_0_10px_currentColor]`}
                />
                <div
                  className={`absolute inset-0 h-3 w-3 rounded-full ${getWhatsappStatusColor()} animate-ping opacity-20`}
                />
              </div>
              <div>
                <div className="text-sm font-bold text-white leading-tight">
                  {getWhatsappStatusText()}
                </div>
                {whatsappVerified ? (
                  <div className="text-[10px] text-[#10b981] font-bold uppercase tracking-widest mt-0.5">
                    Sistema Online
                  </div>
                ) : (
                  <div className="text-[10px] text-[#ef4444] font-bold uppercase tracking-widest mt-0.5">
                    Ação Necessária
                  </div>
                )}
              </div>
            </div>
            {!whatsappVerified ? (
              <Button
                size="icon"
                variant="outline"
                onClick={() => navigate({ to: "/whatsapp" as any })}
                className="h-8 w-8 border-[#2a2a3a] text-[#475569] hover:text-[#7c3aed] hover:border-[#7c3aed]"
                aria-label="Ver estado do WhatsApp"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            ) : (
              <div className="p-2 rounded-lg bg-[#10b98110] text-[#10b981]">
                <Smartphone className="h-4 w-4" />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Filtro de datas */}
      <Card className="bg-[#111118] border-[#2a2a3a] shadow-xl">
        <CardContent className="p-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-[#475569] uppercase tracking-widest mr-2">
            Período
          </span>
          {(
            [
              { id: "1d", label: "1 dia" },
              { id: "7d", label: "7 dias" },
              { id: "30d", label: "30 dias" },
              { id: "custom", label: "Personalizado" },
            ] as { id: RangePreset; label: string }[]
          ).map((opt) => (
            <Button
              key={opt.id}
              size="sm"
              variant={preset === opt.id ? "default" : "outline"}
              onClick={() => setPreset(opt.id)}
              className={cn(
                "rounded-lg text-xs font-bold",
                preset === opt.id
                  ? "bg-[#7c3aed] hover:bg-[#6d28d9] text-white"
                  : "border-[#2a2a3a] text-[#94a3b8] hover:text-white hover:border-[#7c3aed]",
              )}
            >
              {opt.label}
            </Button>
          ))}

          {preset === "custom" && (
            <div className="flex items-center gap-2 ml-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-[#2a2a3a] text-[#94a3b8] rounded-lg text-xs font-bold"
                  >
                    <CalendarIcon className="h-3.5 w-3.5 mr-2" />
                    {customFrom ? format(customFrom, "dd/MM/yy", { locale: ptBR }) : "De"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 bg-[#111118] border-[#2a2a3a]" align="start">
                  <Calendar
                    mode="single"
                    selected={customFrom}
                    onSelect={setCustomFrom}
                    initialFocus
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
              <span className="text-[#475569] text-xs">até</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-[#2a2a3a] text-[#94a3b8] rounded-lg text-xs font-bold"
                  >
                    <CalendarIcon className="h-3.5 w-3.5 mr-2" />
                    {customTo ? format(customTo, "dd/MM/yy", { locale: ptBR }) : "Até"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 bg-[#111118] border-[#2a2a3a]" align="start">
                  <Calendar
                    mode="single"
                    selected={customTo}
                    onSelect={setCustomTo}
                    initialFocus
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
            </div>
          )}

          <div className="ml-auto text-xs text-[#475569] font-medium">
            Exibindo: <span className="text-white font-bold">{rangeLabel}</span>
          </div>
        </CardContent>
      </Card>

      {/* Funil — métricas do período */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
        {funnelCards.map((card) => (
          <Card key={card.title} className="bg-[#111118] border-[#2a2a3a] overflow-hidden relative">
            <div
              className="absolute top-0 left-0 right-0 h-0.5"
              style={{ backgroundColor: card.color }}
            />
            <CardHeader className="flex flex-row items-center justify-between space-y-0 p-5 pb-2">
              <CardTitle className="text-[10px] font-bold text-[#475569] uppercase tracking-widest">
                {card.title}
              </CardTitle>
              <card.icon className="h-4 w-4 opacity-80" style={{ color: card.color }} />
            </CardHeader>
            <CardContent className="p-5 pt-0">
              <div className="text-3xl font-bold text-white mb-1">{card.value}</div>
              <div className="text-[10px] text-[#475569] font-medium">{rangeLabel}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Métricas Principais */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        {metricCards.map((card) => (
          <Card
            key={card.title}
            className="group relative overflow-hidden bg-[#111118] border-[#2a2a3a]"
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 p-5 pb-2">
              <CardTitle className="text-[10px] font-bold text-[#475569] uppercase tracking-widest">
                {card.title}
              </CardTitle>
              <card.icon
                className={`h-4 w-4 ${card.color} opacity-80 group-hover:scale-110 transition-transform`}
              />
            </CardHeader>
            <CardContent className="p-5 pt-0">
              <div className="text-3xl font-bold text-white mb-1">{card.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Gráficos */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <Card className="bg-[#111118] border-[#2a2a3a] lg:col-span-2 shadow-xl">
          <CardHeader>
            <CardTitle className="text-lg">Leads no pipeline por estágio</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={dashboardData?.stageChartData}
                  layout="vertical"
                  margin={{ left: 20 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" horizontal={false} />
                  <XAxis
                    type="number"
                    stroke="#64748b"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    stroke="#64748b"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    width={120}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#0d0d14",
                      border: "1px solid #2a2a3a",
                      borderRadius: "12px",
                      boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
                    }}
                    itemStyle={{ fontSize: "12px", color: "#ffffff" }}
                    labelStyle={{ color: "#ffffff" }}
                  />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {(Array.isArray(dashboardData?.stageChartData)
                      ? dashboardData.stageChartData
                      : []
                    ).map((entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-[#111118] border-[#2a2a3a] shadow-xl">
          <CardHeader>
            <CardTitle className="text-lg">Distribuição por Estágio</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={dashboardData?.stageChartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {(Array.isArray(dashboardData?.stageChartData)
                      ? dashboardData.stageChartData
                      : []
                    ).map((entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#0d0d14",
                      border: "1px solid #2a2a3a",
                      borderRadius: "12px",
                      boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
                    }}
                    itemStyle={{ color: "#ffffff" }}
                    labelStyle={{ color: "#ffffff" }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="grid grid-cols-2 gap-2 mt-4">
                {(Array.isArray(dashboardData?.stageChartData)
                  ? dashboardData.stageChartData
                  : []
                ).map((stage: any) => (
                  <div key={stage.name} className="flex items-center gap-2">
                    <div
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: stage.color }}
                    />
                    <span className="text-xs text-[#64748b] truncate">{stage.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-[#111118] border-[#2a2a3a] md:col-span-2 shadow-xl">
          <CardHeader>
            <CardTitle className="text-lg">Volume por Estágio</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dashboardData?.stageChartData}>
                  <XAxis
                    dataKey="name"
                    stroke="#64748b"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#0d0d14",
                      border: "1px solid #2a2a2a",
                      borderRadius: "12px",
                      boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
                    }}
                    itemStyle={{ color: "#ffffff" }}
                    labelStyle={{ color: "#ffffff" }}
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {(Array.isArray(dashboardData?.stageChartData)
                      ? dashboardData.stageChartData
                      : []
                    ).map((entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-[#111118] border-[#2a2a3a] shadow-xl">
          <CardHeader>
            <CardTitle className="text-lg">Execuções de Fluxo</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {(Array.isArray(dashboardData?.activeExecutions)
                ? dashboardData.activeExecutions
                : []
              ).length ? (
                (Array.isArray(dashboardData?.activeExecutions)
                  ? dashboardData.activeExecutions
                  : []
                ).map((exec: any) => (
                  <div
                    key={exec.id}
                    className="flex items-center justify-between p-4 rounded-xl bg-[#0d0d14] border border-[#2a2a3a] group hover:border-[#7c3aed]/30 transition-all shadow-inner"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-white truncate group-hover:text-[#7c3aed] transition-colors">
                        {safeText(exec.leads?.name || "-")}
                      </div>
                      <div className="text-[11px] font-bold uppercase tracking-wider text-[#475569] truncate mt-0.5">
                        {safeText(exec.flows?.name || "-")}
                      </div>
                    </div>
                    <Badge variant="default" className="text-[10px] animate-pulse">
                      Running
                    </Badge>
                  </div>
                ))
              ) : (
                <div className="text-center py-10 text-[#64748b] text-sm italic">
                  Nenhuma execução ativa.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Listas Inferiores */}
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="bg-[#111118] border-[#2a2a3a] shadow-xl">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Mensagens Recentes</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate({ to: "/logs" })}
              className="text-[#64748b]"
            >
              Ver todos
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {(Array.isArray(dashboardData?.lastMessages) ? dashboardData.lastMessages : [])
                .filter((m: any) => m && m.id)
                .map((msg: any) => (
                  <div
                    key={msg.id}
                    className="flex items-start gap-4 p-3 rounded-lg hover:bg-[#2a2a2a]/50 transition-colors cursor-pointer"
                  >
                    <div
                      className={`p-2 rounded-lg ${msg.direction === "outbound" ? "bg-[#7c3aed15] text-[#7c3aed]" : "bg-[#10b98115] text-[#10b981]"}`}
                    >
                      {msg.direction === "outbound" ? (
                        <ArrowUpRight className="h-4 w-4" />
                      ) : (
                        <ArrowDownLeft className="h-4 w-4" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-start">
                        <div className="text-sm font-bold text-[#f1f5f9]">
                          {safeText(msg.leads?.name || "-")}
                        </div>
                        <div className="text-[10px] text-[#64748b]">
                          {msg.created_at ? format(new Date(msg.created_at), "HH:mm") : "-"}
                        </div>
                      </div>
                      <div className="text-xs text-[#64748b] line-clamp-1">
                        {safeText(msg.content)}
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-[#111118] border-[#2a2a3a] shadow-xl">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Novos Leads</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate({ to: "/leads" })}
              className="text-[#64748b]"
            >
              Ver todos
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {(Array.isArray(dashboardData?.recentLeads) ? dashboardData.recentLeads : [])
                .filter((l: any) => l && l.id)
                .map((lead: any) => (
                  <div
                    key={lead.id}
                    className="flex items-center gap-4 p-3 rounded-xl hover:bg-[#1a1a24]/50 transition-colors cursor-pointer group"
                  >
                    <div className="h-10 w-10 rounded-full bg-linear-to-br from-[#7c3aed] to-[#6d28d9] flex items-center justify-center text-sm font-bold text-white shadow-lg shadow-[#7c3aed]/10">
                      {String(lead.name || "??")
                        .substring(0, 2)
                        .toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-center">
                        <div className="text-sm font-bold text-[#f1f5f9] flex items-center gap-2">
                          {safeText(lead.name || "Sem nome")}
                          {Array.isArray(lead.flow_executions) &&
                            lead.flow_executions.some((ex: any) => ex?.status === "running") && (
                              <div className="h-1.5 w-1.5 rounded-full bg-[#7c3aed] shadow-[0_0_5px_#7c3aed]" />
                            )}
                        </div>
                        <Badge
                          variant="outline"
                          className="text-[10px] border-[#2a2a3a] text-[#475569] group-hover:text-[#94a3b8] transition-colors"
                        >
                          {safeText(lead.pipeline_stages?.name || "N/A")}
                        </Badge>
                      </div>
                      <div className="text-xs text-[#475569] group-hover:text-[#64748b] transition-colors">
                        {safeText(lead.company || lead.phone || "-")}
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      </div>
      <div className="h-20" />
    </div>
  );
}
