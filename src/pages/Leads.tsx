import { useState, useMemo, useEffect } from "react";
import { useLeads, useStages, useDeleteLead } from "@/hooks/use-crm";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Search, Filter, Users, Sparkles, Loader2 } from "lucide-react";
import { LeadDialog } from "./LeadDialog";
import { FlowSelectionDialog } from "./FlowSelectionDialog";
import { safeText } from "@/lib/utils/safeData";
import { LeadTable } from "@/components/LeadTable";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

export default function LeadsPage() {
  const { data: leads, isLoading: leadsLoading } = useLeads();
  const { data: stages } = useStages();
  const deleteLead = useDeleteLead();
  const queryClient = useQueryClient();

  const [searchTerm, setSearchTerm] = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [isLeadDialogOpen, setIsLeadDialogOpen] = useState(false);
  const [selectedLead, setSelectedLead] = useState<any>(null);
  const [isFlowSelectionOpen, setIsFlowSelectionOpen] = useState(false);
  const [flowLeadId, setFlowLeadId] = useState<string>("");
  const [enriching, setEnriching] = useState(false);

  const handleEnrichAll = async (force = false) => {
    if (enriching) return;
    const label = force
      ? "Reprocessar TODOS os leads (inclui já enriquecidos)"
      : "Enriquecer leads pendentes";
    if (
      !window.confirm(`${label}? Pode demorar alguns minutos e consome créditos SerpAPI + OpenAI.`)
    )
      return;
    setEnriching(true);
    const t = toast.loading("Enriquecendo leads... isso pode demorar.");
    try {
      const { data, error } = await supabase.functions.invoke("enrich-lead", {
        body: { all: true, force },
      });
      if (error) throw error;
      toast.success(
        `Concluído. ${data?.processed || 0} enriquecidos, ${data?.failed || 0} falhas (de ${data?.total || 0}).`,
        { id: t },
      );
      queryClient.invalidateQueries({ queryKey: ["leads"] });
    } catch (e: any) {
      toast.error("Falha: " + (e?.message || "erro"), { id: t });
    } finally {
      setEnriching(false);
    }
  };

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === "n" &&
        !["input", "textarea"].includes((e.target as HTMLElement).tagName.toLowerCase())
      ) {
        openCreate();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, []);

  const filteredLeads = useMemo(() => {
    if (!leads) return [];
    return leads.filter((lead) => {
      const matchesSearch =
        lead.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        lead.phone.includes(searchTerm) ||
        (lead.company?.toLowerCase() || "").includes(searchTerm.toLowerCase());

      const matchesStage = stageFilter === "all" || lead.stage_id === stageFilter;

      return matchesSearch && matchesStage;
    });
  }, [leads, searchTerm, stageFilter]);

  const handleDelete = (id: string) => {
    if (window.confirm("Deseja realmente excluir este lead?")) {
      deleteLead.mutate(id);
    }
  };

  const openEdit = (lead: any) => {
    setSelectedLead(lead);
    setIsLeadDialogOpen(true);
  };

  const openCreate = () => {
    setSelectedLead(null);
    setIsLeadDialogOpen(true);
  };

  const openFlowSelection = (leadId: string) => {
    setFlowLeadId(leadId);
    setIsFlowSelectionOpen(true);
  };

  if (leadsLoading) {
    return <div className="p-8 text-center text-[#64748b]">Carregando leads...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-white">Gerenciamento de Leads</h1>
        <div className="flex gap-2 flex-wrap">
          <Button
            onClick={() => handleEnrichAll(false)}
            disabled={enriching}
            variant="outline"
            className="border-[#2a2a3a] bg-[#111118] hover:border-[#7c3aed] text-white"
            title="Busca fotos, sobre, avaliações e Instagram dos leads ainda não enriquecidos"
          >
            {enriching ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-2" />
            )}
            Enriquecer pendentes
          </Button>
          <Button
            onClick={() => handleEnrichAll(true)}
            disabled={enriching}
            variant="outline"
            className="border-[#2a2a3a] bg-[#111118] hover:border-[#ef4444] text-white"
            title="Reprocessa TODOS os leads (mesmo os já enriquecidos)"
          >
            <Sparkles className="h-4 w-4 mr-2" />
            Reprocessar TODOS
          </Button>
          <Button
            onClick={openCreate}
            className="bg-linear-to-br from-[#7c3aed] to-[#6d28d9] hover:brightness-110"
          >
            <Plus className="h-4 w-4 mr-2" />
            Novo Lead
          </Button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-center bg-[#111118] p-4 rounded-xl border border-[#2a2a3a] shadow-xl">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#64748b]" />
          <Input
            placeholder="Buscar por nome, telefone ou empresa..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 bg-[#0f0f0f] border-[#2a2a2a]"
          />
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <Select value={stageFilter} onValueChange={setStageFilter}>
            <SelectTrigger className="w-full sm:w-[180px] bg-[#0f0f0f] border-[#2a2a2a]">
              <Filter className="h-4 w-4 mr-2 text-[#64748b]" />
              <SelectValue placeholder="Filtrar por estágio" />
            </SelectTrigger>
            <SelectContent className="bg-[#1a1a1a] border-[#2a2a2a]">
              <SelectItem value="all">Todos os Estágios</SelectItem>
              {(Array.isArray(stages) ? stages : []).map((stage) => (
                <SelectItem key={stage.id} value={stage.id}>
                  {safeText(stage.name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {filteredLeads.length > 0 ? (
        <LeadTable
          leads={filteredLeads}
          stages={stages || []}
          onEdit={openEdit}
          onDelete={handleDelete}
          onStartFlow={openFlowSelection}
        />
      ) : (
        <div className="bg-[#111118] rounded-xl border border-[#2a2a3a] py-24 shadow-2xl">
          <div className="flex flex-col items-center justify-center space-y-6 text-center">
            <div className="p-8 rounded-full bg-[#7c3aed10] shadow-2xl shadow-[#7c3aed05]">
              <Users className="h-12 w-12 text-[#7c3aed] opacity-80" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-white">Nenhum lead encontrado</h3>
              <p className="text-[#94a3b8] text-sm max-w-xs mx-auto">
                Comece cadastrando seu primeiro lead manualmente ou use o extrator de leads.
              </p>
            </div>
            <Button onClick={openCreate} className="bg-[#7c3aed] hover:bg-[#6d28d9] h-12 px-8">
              <Plus className="h-4 w-4 mr-2" /> Cadastrar Lead
            </Button>
          </div>
        </div>
      )}

      <LeadDialog open={isLeadDialogOpen} onOpenChange={setIsLeadDialogOpen} lead={selectedLead} />

      <FlowSelectionDialog
        open={isFlowSelectionOpen}
        onOpenChange={setIsFlowSelectionOpen}
        leadId={flowLeadId}
      />
      <div className="h-20" />
    </div>
  );
}
