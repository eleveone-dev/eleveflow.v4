import { useLogs } from "@/hooks/use-logs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, Filter, History, X } from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { safeText } from "@/lib/utils/safeData";

const EVENT_TYPES = [
  { id: "all", name: "Todos os eventos" },
  { id: "message_sent", name: "Mensagem enviada" },
  { id: "message_received", name: "Mensagem recebida" },
  { id: "flow_started", name: "Fluxo iniciado" },
  { id: "flow_completed", name: "Fluxo concluído" },
  { id: "flow_error", name: "Erro no fluxo" },
  { id: "stage_changed", name: "Estágio alterado" },
  { id: "objection_created", name: "Objeção criada" },
  { id: "whatsapp_connected", name: "WhatsApp conectado" },
];

export default function LogsPage() {
  const [eventFilter, setEventFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const { data: logs, isLoading } = useLogs({ event: eventFilter, search: searchTerm });

  const getEventBadge = (event: string) => {
    switch (event) {
      case "message_sent":
        return <Badge variant="success">Envio</Badge>;
      case "message_received":
        return <Badge variant="default">Recebido</Badge>;
      case "flow_started":
        return (
          <Badge variant="default" className="bg-[#7c3aed20] text-[#8b5cf6]">
            Início Fluxo
          </Badge>
        );
      case "flow_error":
        return <Badge variant="destructive">Erro</Badge>;
      default:
        return <Badge variant="secondary">{event}</Badge>;
    }
  };

  if (isLoading) return <div className="p-8 text-center">Carregando logs...</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <History className="h-6 w-6 text-[#6366f1]" />
          Logs de Atividade
        </h1>
        <p className="text-[#64748b]">Histórico completo de ações e automações</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 bg-[#1a1a1a] p-4 rounded-lg border border-[#2a2a2a]">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#64748b]" />
          <Input
            placeholder="Buscar nos logs..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 bg-[#0f0f0f] border-[#2a2a2a]"
          />
        </div>
        <Select
          value={eventFilter}
          onValueChange={(v) => {
            try {
              setEventFilter(v);
            } catch (e) {
              console.error(e);
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-[220px] bg-[#0f0f0f] border-[#2a2a2a]">
            <Filter className="h-4 w-4 mr-2 text-[#64748b]" />
            <SelectValue placeholder="Filtrar por evento" />
          </SelectTrigger>
          <SelectContent className="bg-[#1a1a1a] border-[#2a2a2a]">
            {EVENT_TYPES.map((type) => (
              <SelectItem key={type.id} value={type.id}>
                {type.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            try {
              setEventFilter("all");
              setSearchTerm("");
            } catch (e) {
              console.error(e);
            }
          }}
          disabled={eventFilter === "all" && !searchTerm}
          className="border-[#2a2a2a]"
        >
          <X className="h-4 w-4 mr-2" />
          Limpar filtros
        </Button>
      </div>

      <div className="bg-[#1a1a1a] rounded-lg border border-[#2a2a2a] overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-[#2a2a2a] hover:bg-transparent">
              <TableHead>Data</TableHead>
              <TableHead>Evento</TableHead>
              <TableHead>Lead</TableHead>
              <TableHead>Fluxo/Bloco</TableHead>
              <TableHead>Detalhes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(Array.isArray(logs) ? logs : []).map((log) => (
              <TableRow
                key={log.id}
                className="group border-l-2"
                style={{
                  borderLeftColor:
                    log.event === "flow_error"
                      ? "#ef4444"
                      : log.event === "message_sent"
                        ? "#10b981"
                        : log.event === "message_received"
                          ? "#7c3aed"
                          : "transparent",
                }}
              >
                <TableCell className="text-xs text-[#94a3b8] whitespace-nowrap font-medium">
                  {log.created_at
                    ? format(new Date(log.created_at), "dd/MM HH:mm:ss", { locale: ptBR })
                    : "-"}
                </TableCell>
                <TableCell>{getEventBadge(log.event)}</TableCell>
                <TableCell className="font-bold text-sm text-white">
                  {safeText((log.leads as any)?.name || "-")}
                </TableCell>
                <TableCell className="text-xs text-[#94a3b8]">
                  {log.flows ? safeText((log.flows as any).name) : "-"}
                  {log.flow_blocks ? ` / ${safeText((log.flow_blocks as any).type)}` : ""}
                </TableCell>
                <TableCell className="max-w-[300px] truncate text-xs text-[#475569] italic group-hover:text-[#94a3b8] transition-colors">
                  {safeText(log.details)}
                </TableCell>
              </TableRow>
            ))}

            {(Array.isArray(logs) ? logs : []).length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-20 text-[#64748b]">
                  <div className="flex flex-col items-center justify-center space-y-3">
                    <History className="h-10 w-10 opacity-20" />
                    <p>Nenhum log registrado ainda.</p>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="h-20" />
    </div>
  );
}
