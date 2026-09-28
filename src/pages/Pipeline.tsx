import { useLeads, useUpdateLeadStage } from "@/hooks/use-crm";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useState, useMemo, useEffect } from "react";
import { KanbanColumn } from "./KanbanColumn";
import { LeadCard } from "./LeadCard";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { StageDialog } from "./StageDialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { safeText } from "@/lib/utils/safeData";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function PipelinePage() {
  const [stages, setStages] = useState<any[]>([]);
  const [stagesLoading, setStagesLoading] = useState(true);
  const { data: leads, isLoading: leadsLoading } = useLeads();
  const updateLeadStage = useUpdateLeadStage();

  const [activeLead, setActiveLead] = useState<any>(null);
  const [isStageDialogOpen, setIsStageDialogOpen] = useState(false);

  useEffect(() => {
    const fetchStages = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { data, error } = await supabase
        .from("pipeline_stages")
        .select("*")
        .eq("user_id", user.id)
        .order("position", { ascending: true });

      if (error) {
        toast.error("Erro ao carregar estágios");
      } else if (data) {
        setStages(data);
      }
      setStagesLoading(false);
    };

    fetchStages();
  }, []);

  const moveStage = async (stageId: string, direction: "left" | "right") => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const sorted = [...stages].sort((a, b) => (a.position || 0) - (b.position || 0));
    const idx = sorted.findIndex((s) => s.id === stageId);

    if (direction === "left" && idx === 0) return;
    if (direction === "right" && idx === sorted.length - 1) return;

    const swapIdx = direction === "left" ? idx - 1 : idx + 1;

    const newOrder = [...sorted];
    const temp = newOrder[idx];
    newOrder[idx] = newOrder[swapIdx];
    newOrder[swapIdx] = temp;

    // Reescrever TODAS as positions para garantir 0, 1, 2...
    const updates = newOrder.map((stage, i) => ({
      id: stage.id,
      position: i,
    }));

    // Atualizar no banco de forma sequencial ou paralela (paralela é mais rápida)
    const promises = updates.map((update) =>
      supabase
        .from("pipeline_stages")
        .update({ position: update.position })
        .eq("id", update.id)
        .eq("user_id", user.id),
    );

    try {
      await Promise.all(promises);
      // Atualizar estado local
      setStages(newOrder.map((s, i) => ({ ...s, position: i })));
    } catch (err) {
      toast.error("Erro ao reordenar estágios");
    }
  };

  const handleCreateStage = (newStage: any) => {
    setStages((prev) => [...prev, newStage]);
  };

  const handleUpdateStage = (updatedStage: any) => {
    setStages((prev) => prev.map((s) => (s.id === updatedStage.id ? updatedStage : s)));
  };

  const handleDeleteStage = (stageId: string) => {
    setStages((prev) => prev.filter((s) => s.id !== stageId));
  };

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const columns = useMemo(() => {
    const safeStages = Array.isArray(stages) ? stages : [];
    const safeLeads = Array.isArray(leads) ? leads : [];
    return {
      safeStages,
      columns: safeStages.map((stage) => ({
        ...stage,
        leads: safeLeads.filter((lead) => lead && lead.stage_id === stage.id) || [],
      })),
    };
  }, [stages, leads]);

  const handleDragStart = (event: DragStartEvent) => {
    try {
      const { active } = event;
      if (!active?.id) return;
      const leadId = String(active.id);
      const lead = (Array.isArray(leads) ? leads : []).find((l) => l?.id === leadId);
      setActiveLead(lead || null);
    } catch (err) {
      console.error("[Pipeline] drag start falhou:", err);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    try {
      const { active, over } = event;
      setActiveLead(null);
      if (!active?.id || !over?.id) return;

      const leadId = String(active.id);
      const overId = String(over.id);

      let newStageId = overId;
      const overStage = (Array.isArray(stages) ? stages : []).find((s) => s?.id === overId);

      if (!overStage) {
        const overLead = (Array.isArray(leads) ? leads : []).find((l) => l?.id === overId);
        if (overLead) newStageId = overLead.stage_id || "";
      }

      if (!newStageId) return;

      const movingLead = (Array.isArray(leads) ? leads : []).find((l) => l?.id === leadId);
      if (movingLead && movingLead.stage_id !== newStageId) {
        updateLeadStage.mutate({ leadId, stageId: newStageId });
      }
    } catch (err) {
      console.error("[Pipeline] drag end falhou:", err);
      toast.error("Não foi possível mover o lead.");
      setActiveLead(null);
    }
  };

  if (stagesLoading || leadsLoading) {
    return <div className="p-8 text-center text-[#64748b]">Carregando pipeline...</div>;
  }

  return (
    <div className="h-full flex flex-col space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Pipeline de Vendas</h1>
        <Button
          onClick={() => setIsStageDialogOpen(true)}
          className="bg-[#6366f1] hover:bg-[#6366f1]/90"
        >
          <Plus className="h-4 w-4 mr-2" />
          Novo Estágio
        </Button>
      </div>

      <div className="flex-1 overflow-x-auto pb-4">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex h-full space-x-4 min-w-max">
            {columns.columns.length === 0 ? (
              <div className="flex flex-col items-center justify-center w-full py-24 bg-[#111118] rounded-2xl border border-dashed border-[#2a2a3a] space-y-8">
                <div className="p-8 rounded-full bg-[#7c3aed10] shadow-2xl shadow-[#7c3aed05]">
                  <Plus className="h-14 w-14 text-[#7c3aed] opacity-80" />
                </div>
                <div className="text-center space-y-3 px-8">
                  <h3 className="text-2xl font-bold text-white tracking-tight">
                    Seu pipeline está vazio
                  </h3>
                  <p className="text-[#94a3b8] max-w-sm mx-auto text-sm leading-relaxed">
                    Arraste leads para cá para começar.
                  </p>
                </div>
                <Button
                  onClick={() => setIsStageDialogOpen(true)}
                  className="bg-[#7c3aed] hover:bg-[#6d28d9] h-12 px-10 rounded-xl font-bold"
                >
                  Criar Meu Primeiro Estágio
                </Button>
              </div>
            ) : (
              (Array.isArray(columns.columns) ? columns.columns : []).map((column) => (
                <ErrorBoundary key={column.id}>
                  <KanbanColumn
                    column={column}
                    moveStage={moveStage}
                    onUpdateStage={handleUpdateStage}
                    onDeleteStage={handleDeleteStage}
                    isFirst={columns.safeStages.findIndex((s: any) => s.id === column.id) === 0}
                    isLast={
                      columns.safeStages.findIndex((s: any) => s.id === column.id) ===
                      columns.safeStages.length - 1
                    }
                  />
                </ErrorBoundary>
              ))
            )}
          </div>

          <DragOverlay>
            {activeLead ? (
              <div className="w-72 opacity-80 cursor-grabbing">
                <LeadCard lead={activeLead} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <StageDialog
        open={isStageDialogOpen}
        onOpenChange={setIsStageDialogOpen}
        onCreate={handleCreateStage}
        onUpdate={handleUpdateStage}
        onDelete={handleDeleteStage}
        stagesCount={stages.length}
      />
      <div className="h-20" />
    </div>
  );
}
