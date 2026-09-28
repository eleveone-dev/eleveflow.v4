import React, { useState } from "react";
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
import {
  Edit2,
  Trash2,
  MoreHorizontal,
  Play,
  Sparkles,
  ClipboardCopy,
  CheckCircle2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { safeText } from "@/lib/utils/safeData";
import { buildLeadBriefForChatGPT } from "@/lib/leadBrief";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

interface LeadTableProps {
  leads: any[];
  stages: any[];
  onEdit: (lead: any) => void;
  onDelete: (id: string) => void;
  onStartFlow: (id: string) => void;
}

export const LeadTable = ({ leads, stages, onEdit, onDelete, onStartFlow }: LeadTableProps) => {
  const [busyId, setBusyId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const handleCopy = async (lead: any) => {
    const text = buildLeadBriefForChatGPT(lead);
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Dados copiados! Cole no ChatGPT.");
    } catch {
      toast.error("Falha ao copiar. Copie manualmente do console.");
      console.log(text);
    }
  };

  const handleEnrichOne = async (lead: any) => {
    if (busyId) return;
    setBusyId(lead.id);
    const t = toast.loading("Enriquecendo lead...");
    try {
      const { data, error } = await supabase.functions.invoke("enrich-lead", {
        body: { lead_id: lead.id },
      });
      if (error) throw error;
      if (data?.processed) toast.success("Lead enriquecido!", { id: t });
      else toast.error(`Falhou: ${data?.message || "verifique se tem place_id"}`, { id: t });
      queryClient.invalidateQueries({ queryKey: ["leads"] });
    } catch (e: any) {
      toast.error("Erro: " + (e?.message || "desconhecido"), { id: t });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="bg-[#111118] rounded-xl border border-[#2a2a3a] overflow-hidden shadow-2xl">
      <Table>
        <TableHeader className="bg-[#0d0d14]">
          <TableRow className="border-[#2a2a3a] hover:bg-transparent">
            <TableHead className="text-[#94a3b8]">Nome</TableHead>
            <TableHead className="text-[#94a3b8]">Empresa</TableHead>
            <TableHead className="text-[#94a3b8]">Contato</TableHead>
            <TableHead className="text-[#94a3b8]">Estágio</TableHead>
            <TableHead className="text-[#94a3b8]">Enriquecido</TableHead>
            <TableHead className="text-[#94a3b8]">Data</TableHead>
            <TableHead className="text-[#94a3b8] text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {leads.map((lead) => (
            <TableRow
              key={lead.id}
              className="border-[#2a2a2a] hover:bg-[#2a2a2a]/50 transition-colors"
            >
              <TableCell className="font-bold text-white">{safeText(lead.name)}</TableCell>
              <TableCell className="text-[#475569] font-medium">
                {safeText(lead.company || "-")}
              </TableCell>
              <TableCell>
                <div className="flex flex-col text-sm text-[#94a3b8]">
                  <span>{safeText(lead.phone)}</span>
                  <span className="text-xs">{safeText(lead.email || "")}</span>
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="border-[#2a2a2a] bg-[#0f0f0f] text-[#f1f5f9]">
                  {safeText(stages.find((s) => s.id === lead.stage_id)?.name || "N/A")}
                </Badge>
              </TableCell>
              <TableCell>
                {lead.enriched_at ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : (
                  <span className="text-[10px] text-[#64748b]">pendente</span>
                )}
              </TableCell>
              <TableCell className="text-[#64748b] text-xs">
                {lead.created_at
                  ? format(new Date(lead.created_at), "dd/MM/yy HH:mm", { locale: ptBR })
                  : "-"}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-[#7c3aed] hover:bg-[#7c3aed]/10"
                    onClick={() => handleCopy(lead)}
                    title="Copiar dados para ChatGPT"
                  >
                    <ClipboardCopy className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-amber-400 hover:bg-amber-400/10"
                    onClick={() => handleEnrichOne(lead)}
                    disabled={busyId === lead.id}
                    title="Enriquecer este lead"
                  >
                    <Sparkles className={`h-4 w-4 ${busyId === lead.id ? "animate-pulse" : ""}`} />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="bg-[#1a1a1a] border-[#2a2a3a]">
                      <DropdownMenuItem
                        onClick={() => onEdit(lead)}
                        className="text-white hover:bg-[#2a2a2a] cursor-pointer"
                      >
                        <Edit2 className="h-4 w-4 mr-2" /> Editar
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => onStartFlow(lead.id)}
                        className="text-white hover:bg-[#2a2a2a] cursor-pointer"
                      >
                        <Play className="h-4 w-4 mr-2" /> Iniciar Fluxo
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => onDelete(lead.id)}
                        className="text-red-400 hover:bg-red-400/10 cursor-pointer"
                      >
                        <Trash2 className="h-4 w-4 mr-2" /> Excluir
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
