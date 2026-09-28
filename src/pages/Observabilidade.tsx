import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { format, parseISO, subDays } from "date-fns";
import {
  AlertTriangle,
  BarChart3,
  Bot,
  Braces,
  MessageSquare,
  RotateCw,
  Search,
  Timer,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Views/tabelas da fase C ainda não existem no types.ts gerado; cliente sem schema só neste arquivo.
const db = supabase as unknown as SupabaseClient;

const fmtUsd = (micros: number | null | undefined) => `$${((micros ?? 0) / 1_000_000).toFixed(4)}`;

const fmtInt = (n: number | null | undefined) => (n ?? 0).toLocaleString("pt-BR");

const parseTs = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const d = new Date(value.includes("T") ? value : value.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
};

const fmtDateTime = (value: string | null | undefined): string => {
  const d = parseTs(value);
  return d ? format(d, "dd/MM HH:mm") : "—";
};

const fmtTime = (value: string | null | undefined): string => {
  const d = parseTs(value);
  return d ? format(d, "HH:mm") : "—";
};

const fmtChartDay = (day: string): string => format(parseISO(day), "dd/MM");

const fmtDelay = (seconds: number | null | undefined): string => {
  if (seconds == null) return "—";
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
};

// Ordem fixa validada para CVD sobre #111118 (ΔE adjacente mínimo 10.3) — não reordenar nem ciclar.
const SERIES_COLORS = [
  "#3987e5",
  "#199e70",
  "#c98500",
  "#008300",
  "#9085e9",
  "#e66767",
  "#d55181",
  "#d95926",
];

const OTHERS_KEY = "outros";

const FEATURE_LABELS: Record<string, string> = {
  agent_reply: "Resposta do agente",
  agent_opening: "Abertura do agente",
  stage_classifier: "Classificador de etapa",
  photo_vision: "Visão (fotos)",
  extract_search: "Extração (busca)",
  enrich_details: "Enriquecimento (detalhes)",
  enrich_photos: "Enriquecimento (fotos)",
  enrich_reviews: "Enriquecimento (avaliações)",
  instagram_profile: "Perfil Instagram",
  [OTHERS_KEY]: "Outros",
};

const featureLabel = (feature: string | null | undefined): string =>
  feature ? (FEATURE_LABELS[feature] ?? feature) : "—";

const providerLabel = (provider: string | null | undefined): string => {
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "serpapi") return "SerpAPI";
  return provider ?? "—";
};

const AGENT_STATUS: Record<string, { label: string; badge: string; dot: string }> = {
  goal: {
    label: "Objetivo",
    badge: "border-transparent bg-[#10b98120] text-[#10b981]",
    dot: "bg-[#10b981]",
  },
  giveup: {
    label: "Desistiu",
    badge: "border-transparent bg-[#ef444420] text-[#ef4444]",
    dot: "bg-[#ef4444]",
  },
  limit: {
    label: "Limite",
    badge: "border-transparent bg-[#f59e0b20] text-[#f59e0b]",
    dot: "bg-[#f59e0b]",
  },
  active: {
    label: "Ativa",
    badge: "border-transparent bg-[#3b82f620] text-[#3b82f6]",
    dot: "bg-[#3b82f6]",
  },
};

const agentStatus = (status: string) =>
  AGENT_STATUS[status] ?? {
    label: status,
    badge: "border-transparent bg-[#47556920] text-[#94a3b8]",
    dot: "bg-[#64748b]",
  };

interface ApiStats {
  cost_today_usd_micros: number | null;
  cost_7d_usd_micros: number | null;
  cost_30d_usd_micros: number | null;
  calls_7d: number | null;
  errors_7d: number | null;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
}

interface DailyCost {
  user_id: string;
  day: string;
  provider: string;
  feature: string;
  calls: number | null;
  errors: number | null;
  cost_usd_micros: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

interface WaHealth {
  sent_7d: number | null;
  failed_7d: number | null;
  pending_now: number | null;
  avg_queue_delay_s: number | null;
}

interface AgentSession {
  execution_id: string;
  lead_id: string;
  lead_name: string | null;
  lead_phone: string | null;
  flow_id: string | null;
  agent_status: string;
  turns: number | null;
  block_id: string | null;
  started_at: string | null;
  cost_usd_micros: number | null;
  created_at: string | null;
}

interface ApiCallRow {
  id: string;
  created_at: string | null;
  provider: string | null;
  feature: string | null;
  model: string | null;
  status: string | null;
  error_message: string | null;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd_micros: number | null;
}

interface CallDetail {
  request: unknown;
  response: unknown;
}

interface TranscriptMsg {
  direction: string | null;
  content: string | null;
  created_at: string | null;
}

interface TurnCall {
  created_at: string | null;
  feature: string | null;
  cost_usd_micros: number | null;
  status: string | null;
}

type ChartRow = Record<string, number | string>;

type TooltipEntry = {
  dataKey?: string | number;
  value?: number | string;
  color?: string;
};

function CostTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce((acc, item) => acc + (Number(item.value) || 0), 0);
  const rows = payload
    .filter((item) => Number(item.value) > 0)
    .slice()
    .sort((a, b) => Number(b.value) - Number(a.value));
  return (
    <div className="rounded-xl border border-[#2a2a3a] bg-[#0d0d14] px-3.5 py-3 shadow-2xl">
      <div className="flex items-baseline justify-between gap-6">
        <span className="text-[11px] font-bold uppercase tracking-wider text-[#64748b]">
          {typeof label === "string" ? fmtChartDay(label) : label}
        </span>
        <span className="text-sm font-bold tabular-nums text-white">{fmtUsd(total)}</span>
      </div>
      {rows.length > 0 && (
        <div className="mt-2 space-y-1">
          {rows.map((item) => (
            <div key={String(item.dataKey)} className="flex items-center justify-between gap-6">
              <span className="flex items-center gap-1.5 text-xs text-[#94a3b8]">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                {featureLabel(String(item.dataKey))}
              </span>
              <span className="text-xs tabular-nums text-[#e2e8f0]">
                {fmtUsd(Number(item.value))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#475569]">
      {children}
    </div>
  );
}

function EmptyBlock({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="rounded-2xl border border-[#1e1e2e] bg-[#0d0d14] p-3 text-[#475569]">
        <Icon className="h-5 w-5" />
      </div>
      <div className="text-sm font-semibold text-[#94a3b8]">{title}</div>
      <div className="max-w-[320px] text-xs text-[#475569]">{hint}</div>
    </div>
  );
}

function ErrorBlock({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message =
    error instanceof Error ? error.message : "Falha desconhecida ao consultar o Supabase.";
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
      <div className="flex items-center gap-2 text-sm font-semibold text-[#ef4444]">
        <AlertTriangle className="h-4 w-4" />
        Não foi possível carregar
      </div>
      <div className="max-w-[360px] text-xs text-[#64748b]">{message}</div>
      <Button
        size="sm"
        variant="outline"
        onClick={onRetry}
        className="border-[#2a2a3a] text-[#94a3b8] hover:border-[#7c3aed] hover:text-white"
      >
        <RotateCw className="mr-2 h-3.5 w-3.5" />
        Tentar novamente
      </Button>
    </div>
  );
}

function PayloadBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <SectionEyebrow>{title}</SectionEyebrow>
      {value == null ? (
        <p className="mt-2 text-xs italic text-[#475569]">Sem payload registrado.</p>
      ) : (
        <pre className="mt-2 max-h-[60vh] overflow-auto rounded-xl border border-[#1e1e2e] bg-[#0a0a0f] p-3 text-xs text-[#94a3b8]">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function Observabilidade() {
  const [selectedSession, setSelectedSession] = useState<AgentSession | null>(null);
  const [selectedCall, setSelectedCall] = useState<ApiCallRow | null>(null);

  const statsQuery = useQuery({
    queryKey: ["obs-stats"],
    queryFn: async (): Promise<ApiStats | null> => {
      const { data, error } = await db.from("api_stats").select("*").maybeSingle();
      if (error) throw error;
      return (data as ApiStats | null) ?? null;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const dailyQuery = useQuery({
    queryKey: ["obs-daily"],
    queryFn: async (): Promise<DailyCost[]> => {
      const { data, error } = await db
        .from("api_costs_daily")
        .select("*")
        .order("day", { ascending: true });
      if (error) throw error;
      return (data as DailyCost[] | null) ?? [];
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const waQuery = useQuery({
    queryKey: ["obs-wa"],
    queryFn: async (): Promise<WaHealth | null> => {
      const { data, error } = await db.from("whatsapp_health").select("*").maybeSingle();
      if (error) throw error;
      return (data as WaHealth | null) ?? null;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const sessionsQuery = useQuery({
    queryKey: ["obs-sessions"],
    queryFn: async (): Promise<AgentSession[]> => {
      const { data, error } = await db
        .from("agent_sessions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data as AgentSession[] | null) ?? [];
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const callsQuery = useQuery({
    queryKey: ["obs-calls"],
    queryFn: async (): Promise<ApiCallRow[]> => {
      const { data, error } = await db
        .from("api_calls")
        .select(
          "id, created_at, provider, feature, model, status, error_message, latency_ms, prompt_tokens, completion_tokens, cost_usd_micros",
        )
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data as ApiCallRow[] | null) ?? [];
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const transcriptQuery = useQuery({
    queryKey: ["obs-transcript", selectedSession?.execution_id],
    enabled: !!selectedSession,
    queryFn: async (): Promise<{ messages: TranscriptMsg[]; calls: TurnCall[] }> => {
      const session = selectedSession;
      if (!session) return { messages: [], calls: [] };
      const [msgs, turnCalls] = await Promise.all([
        db
          .from("messages")
          .select("direction, content, created_at")
          .eq("lead_id", session.lead_id)
          .order("created_at", { ascending: true })
          .limit(80),
        db
          .from("api_calls")
          .select("created_at, feature, cost_usd_micros, status")
          .eq("execution_id", session.execution_id)
          .order("created_at", { ascending: true }),
      ]);
      if (msgs.error) throw msgs.error;
      if (turnCalls.error) throw turnCalls.error;
      return {
        messages: (msgs.data as TranscriptMsg[] | null) ?? [],
        calls: (turnCalls.data as TurnCall[] | null) ?? [],
      };
    },
  });

  const callDetailQuery = useQuery({
    queryKey: ["obs-call-detail", selectedCall?.id],
    enabled: !!selectedCall,
    queryFn: async (): Promise<CallDetail | null> => {
      const call = selectedCall;
      if (!call) return null;
      const { data, error } = await db
        .from("api_calls")
        .select("request, response")
        .eq("id", call.id)
        .maybeSingle();
      if (error) throw error;
      return (data as CallDetail | null) ?? null;
    },
  });

  const stats = statsQuery.data;
  const wa = waQuery.data;
  const daily = dailyQuery.data;
  const sessions = sessionsQuery.data;
  const calls = callsQuery.data;

  const errorRate = useMemo(() => {
    if (!stats?.calls_7d) return null;
    return ((stats.errors_7d ?? 0) / stats.calls_7d) * 100;
  }, [stats]);

  const serp7d = useMemo(() => {
    const cutoff = subDays(new Date(), 7);
    return (daily ?? [])
      .filter((row) => row.provider === "serpapi" && parseISO(row.day) >= cutoff)
      .reduce((acc, row) => acc + (row.calls ?? 0), 0);
  }, [daily]);

  // Últimos 14 dias em calendário contínuo, custo em micros (inteiro); conversão só na exibição.
  const { chartData, features, chartHasData } = useMemo(() => {
    const rows = daily ?? [];
    const totals = new Map<string, number>();
    for (const row of rows) {
      totals.set(row.feature, (totals.get(row.feature) ?? 0) + (row.cost_usd_micros ?? 0));
    }
    let feats = Array.from(totals.keys()).sort();
    if (feats.length > 8) {
      const top = Array.from(totals.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 7)
        .map(([feature]) => feature);
      feats = [...top.sort(), OTHERS_KEY];
    }
    const byDay = new Map<string, ChartRow>();
    for (let i = 13; i >= 0; i--) {
      const key = format(subDays(new Date(), i), "yyyy-MM-dd");
      const entry: ChartRow = { day: key };
      for (const feature of feats) entry[feature] = 0;
      byDay.set(key, entry);
    }
    let windowTotal = 0;
    for (const row of rows) {
      const entry = byDay.get(String(row.day));
      if (!entry) continue;
      const key = feats.includes(row.feature) ? row.feature : OTHERS_KEY;
      const value = row.cost_usd_micros ?? 0;
      entry[key] = (Number(entry[key]) || 0) + value;
      windowTotal += value;
    }
    return {
      chartData: Array.from(byDay.values()),
      features: feats,
      chartHasData: windowTotal > 0,
    };
  }, [daily]);

  const transcript = transcriptQuery.data;
  const callDetail = callDetailQuery.data;

  return (
    <div className="space-y-8 pb-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight text-white">Observabilidade</h1>
        <p className="text-sm font-medium text-[#475569]">
          Custos de IA, conversas do agente e saúde dos envios. Atualiza a cada 60 s.
        </p>
      </div>

      {/* Custos + saúde WhatsApp */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="relative overflow-hidden border-[#2a2a3a] bg-[#111118] shadow-xl lg:col-span-2">
          <div className="absolute left-0 right-0 top-0 h-0.5 bg-linear-to-r from-[#7c3aed] to-[#3b82f6]" />
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <SectionEyebrow>Custos de IA</SectionEyebrow>
              <span className="text-[10px] font-medium text-[#475569]">OpenRouter + SerpAPI</span>
            </div>
            {statsQuery.isLoading ? (
              <div className="mt-5 grid grid-cols-3 gap-6">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : statsQuery.isError ? (
              <ErrorBlock error={statsQuery.error} onRetry={() => statsQuery.refetch()} />
            ) : (
              <div className="mt-4 grid grid-cols-3 divide-x divide-[#1e1e2e]">
                <div className="pr-4">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-[#475569]">
                    Hoje
                  </div>
                  <div className="mt-1.5 text-2xl font-bold text-[#cbd5e1]">
                    {fmtUsd(stats?.cost_today_usd_micros)}
                  </div>
                </div>
                <div className="px-4">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-[#475569]">
                    7 dias
                  </div>
                  <div className="mt-1.5 text-2xl font-bold text-[#cbd5e1]">
                    {fmtUsd(stats?.cost_7d_usd_micros)}
                  </div>
                </div>
                <div className="pl-4">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-[#7c3aed]">
                    30 dias
                  </div>
                  <div
                    data-testid="cost-30d"
                    className="mt-1 text-4xl font-bold leading-tight text-white lg:text-5xl"
                  >
                    {fmtUsd(stats?.cost_30d_usd_micros)}
                  </div>
                  <div className="mt-1 text-[10px] font-medium text-[#475569]">janela corrida</div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-[#2a2a3a] bg-[#111118] shadow-xl">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <SectionEyebrow>Saúde do WhatsApp</SectionEyebrow>
              <MessageSquare className="h-4 w-4 text-[#10b981] opacity-80" />
            </div>
            {waQuery.isLoading ? (
              <div className="mt-5 space-y-3">
                <Skeleton className="h-10 w-24" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : waQuery.isError ? (
              <ErrorBlock error={waQuery.error} onRetry={() => waQuery.refetch()} />
            ) : (
              <>
                <div className="mt-4 text-4xl font-bold text-white">{fmtInt(wa?.sent_7d)}</div>
                <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-[#475569]">
                  enviadas em 7 dias
                </div>
                <div className="mt-5 grid grid-cols-3 gap-3">
                  <div>
                    <div className="text-[10px] font-medium text-[#475569]">Falhas 7d</div>
                    <div
                      className={`mt-0.5 text-sm font-bold ${
                        (wa?.failed_7d ?? 0) > 0 ? "text-[#ef4444]" : "text-[#e2e8f0]"
                      }`}
                    >
                      {fmtInt(wa?.failed_7d)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-medium text-[#475569]">Fila agora</div>
                    <div className="mt-0.5 text-sm font-bold text-[#e2e8f0]">
                      {fmtInt(wa?.pending_now)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-medium text-[#475569]">Atraso médio</div>
                    <div className="mt-0.5 text-sm font-bold text-[#e2e8f0]">
                      {fmtDelay(wa?.avg_queue_delay_s)}
                    </div>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tiles de operação */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card className="border-[#2a2a3a] bg-[#111118]">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#475569]">
                Chamadas de IA (7d)
              </div>
              <Zap className="h-4 w-4 text-[#7c3aed] opacity-80" />
            </div>
            <div className="mt-2 text-3xl font-bold text-white">
              {statsQuery.isLoading ? "…" : fmtInt(stats?.calls_7d)}
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#2a2a3a] bg-[#111118]">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#475569]">
                Taxa de erro (7d)
              </div>
              <AlertTriangle className="h-4 w-4 text-[#f59e0b] opacity-80" />
            </div>
            <div
              className={`mt-2 text-3xl font-bold ${
                errorRate != null && errorRate > 0 ? "text-[#f59e0b]" : "text-white"
              }`}
            >
              {statsQuery.isLoading ? "…" : errorRate == null ? "—" : `${errorRate.toFixed(1)}%`}
            </div>
            <div className="mt-1 text-[10px] font-medium text-[#475569]">
              {fmtInt(stats?.errors_7d)} erros em {fmtInt(stats?.calls_7d)} chamadas
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#2a2a3a] bg-[#111118]">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#475569]">
                Latência p50
              </div>
              <Timer className="h-4 w-4 text-[#3b82f6] opacity-80" />
            </div>
            <div className="mt-2 text-3xl font-bold text-white">
              {statsQuery.isLoading ? "…" : `${fmtInt(Math.round(stats?.latency_p50_ms ?? 0))} ms`}
            </div>
            <div className="mt-1 text-[10px] font-medium text-[#475569]">
              p95 {fmtInt(Math.round(stats?.latency_p95_ms ?? 0))} ms
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#2a2a3a] bg-[#111118]">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#475569]">
                Buscas SerpAPI (7d)
              </div>
              <Search className="h-4 w-4 text-[#06b6d4] opacity-80" />
            </div>
            <div className="mt-2 text-3xl font-bold text-white">
              {dailyQuery.isLoading ? "…" : fmtInt(serp7d)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Custo por dia (14d) empilhado por feature */}
      <Card className="border-[#2a2a3a] bg-[#111118] shadow-xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Custo por dia</CardTitle>
          <p className="text-xs font-medium text-[#475569]">
            Últimos 14 dias, empilhado por feature
          </p>
        </CardHeader>
        <CardContent>
          {dailyQuery.isLoading ? (
            <Skeleton className="h-[280px] w-full rounded-xl" />
          ) : dailyQuery.isError ? (
            <ErrorBlock error={dailyQuery.error} onRetry={() => dailyQuery.refetch()} />
          ) : !chartHasData ? (
            <EmptyBlock
              icon={BarChart3}
              title="Sem custos nos últimos 14 dias"
              hint="Execute um fluxo com bloco de IA ou uma extração do Google Maps para registrar chamadas aqui."
            />
          ) : (
            <>
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="#1e1e2e" />
                    <XAxis
                      dataKey="day"
                      stroke="#475569"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={fmtChartDay}
                    />
                    <YAxis
                      stroke="#475569"
                      fontSize={11}
                      width={74}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value: number) => fmtUsd(value)}
                    />
                    <Tooltip content={<CostTooltip />} cursor={{ fill: "#1e1e2e", opacity: 0.5 }} />
                    {features.map((feature, index) => (
                      <Bar
                        key={feature}
                        dataKey={feature}
                        stackId="cost"
                        fill={SERIES_COLORS[index % SERIES_COLORS.length]}
                        stroke="#111118"
                        strokeWidth={2}
                        maxBarSize={24}
                        radius={index === features.length - 1 ? [3, 3, 0, 0] : undefined}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {features.length >= 2 && (
                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
                  {features.map((feature, index) => (
                    <span
                      key={feature}
                      className="flex items-center gap-1.5 text-xs text-[#94a3b8]"
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length] }}
                      />
                      {featureLabel(feature)}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Feed do agente + chamadas de API */}
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="border-[#2a2a3a] bg-[#111118] shadow-xl lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Conversas do agente</CardTitle>
            <p className="text-xs font-medium text-[#475569]">
              Últimas 20 sessões · clique para ver o transcript
            </p>
          </CardHeader>
          <CardContent>
            {sessionsQuery.isLoading ? (
              <div className="space-y-2">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-xl" />
                ))}
              </div>
            ) : sessionsQuery.isError ? (
              <ErrorBlock error={sessionsQuery.error} onRetry={() => sessionsQuery.refetch()} />
            ) : (sessions ?? []).length === 0 ? (
              <EmptyBlock
                icon={Bot}
                title="Nenhuma conversa do agente ainda"
                hint="Sessões aparecem quando um fluxo com bloco de agente de IA conversa com um lead."
              />
            ) : (
              <div className="max-h-[430px] space-y-2 overflow-y-auto pr-1">
                {(sessions ?? []).map((session) => {
                  const st = agentStatus(session.agent_status);
                  return (
                    <button
                      key={session.execution_id}
                      data-testid="agent-session"
                      onClick={() => setSelectedSession(session)}
                      className="w-full rounded-xl border border-[#1e1e2e] bg-[#0d0d14] p-3 text-left transition-colors hover:border-[#7c3aed]/40"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate text-sm font-bold text-[#f1f5f9]">
                          {session.lead_name ?? "Lead sem nome"}
                        </span>
                        <Badge className={`${st.badge} shrink-0`}>
                          <span className={`mr-1.5 h-1.5 w-1.5 rounded-full ${st.dot}`} />
                          {st.label}
                        </Badge>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-[#64748b]">
                        <span className="truncate">
                          {fmtInt(session.turns)} turnos · {fmtDateTime(session.started_at)}
                        </span>
                        <span className="shrink-0 tabular-nums text-[#94a3b8]">
                          {fmtUsd(session.cost_usd_micros)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-[#2a2a3a] bg-[#111118] shadow-xl lg:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Chamadas de API</CardTitle>
            <p className="text-xs font-medium text-[#475569]">
              Últimas 50 · clique para inspecionar request e response
            </p>
          </CardHeader>
          <CardContent className="pt-0">
            {callsQuery.isLoading ? (
              <div className="space-y-2">
                {[...Array(6)].map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full rounded-lg" />
                ))}
              </div>
            ) : callsQuery.isError ? (
              <ErrorBlock error={callsQuery.error} onRetry={() => callsQuery.refetch()} />
            ) : (calls ?? []).length === 0 ? (
              <EmptyBlock
                icon={Braces}
                title="Nenhuma chamada de API registrada"
                hint="Cada chamada ao OpenRouter ou à SerpAPI aparece aqui com latência, tokens e custo."
              />
            ) : (
              <div className="max-h-[430px] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Data</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Feature</TableHead>
                      <TableHead>Modelo</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Latência</TableHead>
                      <TableHead className="text-right">Tokens</TableHead>
                      <TableHead className="text-right">Custo</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(calls ?? []).map((row) => (
                      <TableRow
                        key={row.id}
                        onClick={() => setSelectedCall(row)}
                        className="cursor-pointer"
                      >
                        <TableCell className="whitespace-nowrap py-3 text-xs text-[#94a3b8]">
                          {fmtDateTime(row.created_at)}
                        </TableCell>
                        <TableCell className="py-3 text-xs text-[#94a3b8]">
                          {providerLabel(row.provider)}
                        </TableCell>
                        <TableCell className="py-3 text-xs text-[#94a3b8]">
                          {featureLabel(row.feature)}
                        </TableCell>
                        <TableCell className="py-3">
                          <span
                            className="block max-w-[140px] truncate text-xs text-[#94a3b8]"
                            title={row.model ?? undefined}
                          >
                            {row.model ?? "—"}
                          </span>
                        </TableCell>
                        <TableCell className="py-3">
                          {row.status === "ok" ? (
                            <span className="flex items-center gap-1.5 text-xs text-[#10b981]">
                              <span className="h-1.5 w-1.5 rounded-full bg-[#10b981]" />
                              ok
                            </span>
                          ) : (
                            <span
                              className="flex max-w-[160px] items-center gap-1.5 text-xs text-[#ef4444]"
                              title={row.error_message ?? row.status ?? undefined}
                            >
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#ef4444]" />
                              <span className="truncate">
                                {row.error_message ?? row.status ?? "erro"}
                              </span>
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap py-3 text-right text-xs tabular-nums text-[#94a3b8]">
                          {row.latency_ms != null ? `${fmtInt(row.latency_ms)} ms` : "—"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap py-3 text-right text-xs tabular-nums text-[#94a3b8]">
                          {row.prompt_tokens != null || row.completion_tokens != null
                            ? `${fmtInt(row.prompt_tokens)} → ${fmtInt(row.completion_tokens)}`
                            : "—"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap py-3 text-right text-xs font-semibold tabular-nums text-[#e2e8f0]">
                          {fmtUsd(row.cost_usd_micros)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Dialog: transcript da sessão do agente */}
      <Dialog
        open={!!selectedSession}
        onOpenChange={(open) => {
          if (!open) setSelectedSession(null);
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {selectedSession && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3">
                  {selectedSession.lead_name ?? "Lead sem nome"}
                  <Badge className={agentStatus(selectedSession.agent_status).badge}>
                    <span
                      className={`mr-1.5 h-1.5 w-1.5 rounded-full ${agentStatus(selectedSession.agent_status).dot}`}
                    />
                    {agentStatus(selectedSession.agent_status).label}
                  </Badge>
                </DialogTitle>
                <DialogDescription className="text-[#64748b]">
                  {selectedSession.lead_phone ?? "sem telefone"} · {fmtInt(selectedSession.turns)}{" "}
                  turnos · início {fmtDateTime(selectedSession.started_at)} · total{" "}
                  <span className="tabular-nums text-[#e2e8f0]">
                    {fmtUsd(selectedSession.cost_usd_micros)}
                  </span>
                </DialogDescription>
              </DialogHeader>
              {transcriptQuery.isLoading ? (
                <div className="space-y-2">
                  {[...Array(4)].map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full rounded-xl" />
                  ))}
                </div>
              ) : transcriptQuery.isError ? (
                <ErrorBlock
                  error={transcriptQuery.error}
                  onRetry={() => transcriptQuery.refetch()}
                />
              ) : (
                <>
                  <div className="max-h-[38vh] space-y-2 overflow-y-auto rounded-xl border border-[#1e1e2e] bg-[#0a0a0f] p-4">
                    {(transcript?.messages ?? []).length === 0 ? (
                      <p className="py-4 text-center text-xs italic text-[#475569]">
                        Sem mensagens registradas para este lead.
                      </p>
                    ) : (
                      (transcript?.messages ?? []).map((msg, index) => {
                        const outbound = msg.direction === "outbound";
                        return (
                          <div
                            key={index}
                            className={`flex ${outbound ? "justify-end" : "justify-start"}`}
                          >
                            <div
                              className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                                outbound
                                  ? "rounded-br-sm bg-[#7c3aed26] text-[#e9d5ff]"
                                  : "rounded-bl-sm bg-[#1a1a24] text-[#e2e8f0]"
                              }`}
                            >
                              <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                              <div className="mt-1 text-[10px] text-[#64748b]">
                                {fmtTime(msg.created_at)}
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <div>
                    <SectionEyebrow>Custo por turno</SectionEyebrow>
                    {(transcript?.calls ?? []).length === 0 ? (
                      <p className="mt-2 text-xs italic text-[#475569]">
                        Nenhuma chamada de IA vinculada a esta execução.
                      </p>
                    ) : (
                      <div className="mt-2 max-h-[22vh] space-y-1 overflow-y-auto pr-1">
                        {(transcript?.calls ?? []).map((call, index) => (
                          <div
                            key={index}
                            className="flex items-center justify-between rounded-lg border border-[#1e1e2e] bg-[#0d0d14] px-3 py-1.5 text-xs"
                          >
                            <span className="text-[#94a3b8]">
                              #{index + 1} · {featureLabel(call.feature)} ·{" "}
                              {fmtTime(call.created_at)}
                            </span>
                            <span
                              className={`tabular-nums ${
                                call.status === "ok" ? "text-[#e2e8f0]" : "text-[#ef4444]"
                              }`}
                            >
                              {fmtUsd(call.cost_usd_micros)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Dialog: drill-down de chamada de API */}
      <Dialog
        open={!!selectedCall}
        onOpenChange={(open) => {
          if (!open) setSelectedCall(null);
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          {selectedCall && (
            <>
              <DialogHeader>
                <DialogTitle>
                  Chamada {providerLabel(selectedCall.provider)} ·{" "}
                  {featureLabel(selectedCall.feature)}
                </DialogTitle>
                <DialogDescription className="text-[#64748b]">
                  {fmtDateTime(selectedCall.created_at)} · {selectedCall.model ?? "sem modelo"} ·{" "}
                  {selectedCall.latency_ms != null ? `${fmtInt(selectedCall.latency_ms)} ms` : "—"}{" "}
                  · <span className="tabular-nums">{fmtUsd(selectedCall.cost_usd_micros)}</span>
                </DialogDescription>
              </DialogHeader>
              {selectedCall.error_message && (
                <div className="rounded-lg border border-[#ef444420] bg-[#ef444408] px-3 py-2 text-xs text-[#ef4444]">
                  {selectedCall.error_message}
                </div>
              )}
              {callDetailQuery.isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-24 w-full rounded-xl" />
                  <Skeleton className="h-24 w-full rounded-xl" />
                </div>
              ) : callDetailQuery.isError ? (
                <ErrorBlock
                  error={callDetailQuery.error}
                  onRetry={() => callDetailQuery.refetch()}
                />
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  <PayloadBlock title="Request" value={callDetail?.request} />
                  <PayloadBlock title="Response" value={callDetail?.response} />
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
