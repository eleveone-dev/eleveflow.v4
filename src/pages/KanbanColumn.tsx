import { useDroppable } from "@dnd-kit/core";
import { LeadCard } from "./LeadCard";
import {
  Plus,
  MoreVertical,
  Settings,
  LayoutGrid,
  ArrowLeft,
  ArrowRight,
  Edit,
  Palette,
  Trash,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { LeadDialog } from "./LeadDialog";
import { StageDialog } from "./StageDialog";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { safeText } from "@/lib/utils/safeData";
import { ErrorBoundary } from "@/components/ErrorBoundary";

interface KanbanColumnProps {
  column: any;
  moveStage: (stageId: string, direction: "left" | "right") => Promise<void>;
  onUpdateStage: (updatedStage: any) => void;
  onDeleteStage: (stageId: string) => void;
  isFirst: boolean;
  isLast: boolean;
}

export function KanbanColumn({
  column,
  moveStage,
  onUpdateStage,
  onDeleteStage,
  isFirst,
  isLast,
}: KanbanColumnProps) {
  const { setNodeRef } = useDroppable({
    id: column.id,
  });

  const [isLeadDialogOpen, setIsLeadDialogOpen] = useState(false);
  const [isStageSettingsOpen, setIsStageSettingsOpen] = useState(false);

  const handleMove = async (direction: "left" | "right") => {
    await moveStage(column.id, direction);
  };

  const handleDelete = async () => {
    if (
      window.confirm(
        "Tem certeza que deseja excluir este estágio? Leads vinculados ficarão sem estágio.",
      )
    ) {
      const { error } = await supabase.from("pipeline_stages").delete().eq("id", column.id);
      if (error) {
        toast.error("Erro ao excluir estágio");
      } else {
        onDeleteStage(column.id);
        toast.success("Estágio excluído!");
      }
    }
  };

  return (
    <div className="w-72 flex flex-col bg-[#111118] rounded-xl border border-[#2a2a3a] max-h-full shadow-2xl overflow-hidden">
      <div className="p-4 flex items-center justify-between border-b border-[#2a2a3a] bg-[#0d0d14]">
        <div className="flex items-center space-x-2.5">
          <div
            className="w-3 h-3 rounded-full shadow-lg"
            style={{
              backgroundColor: column.color || "#7c3aed",
              boxShadow: `0 0 10px ${column.color || "#7c3aed"}40`,
            }}
          />
          <h3 className="font-bold text-xs uppercase tracking-widest text-white">
            {safeText(column.name)}
          </h3>
          <Badge variant="default" className="text-[10px] px-2 py-0 h-5">
            {(Array.isArray(column.leads) ? column.leads : []).length}
          </Badge>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-[#475569] hover:text-white">
              <Settings className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bg-[#111118] border-[#2a2a3a] text-white">
            {!isFirst && (
              <DropdownMenuItem
                onClick={() => handleMove("left")}
                className="cursor-pointer focus:bg-[#2a2a3a] focus:text-white"
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                Mover para esquerda
              </DropdownMenuItem>
            )}
            {!isLast && (
              <DropdownMenuItem
                onClick={() => handleMove("right")}
                className="cursor-pointer focus:bg-[#2a2a3a] focus:text-white"
              >
                <ArrowRight className="h-4 w-4 mr-2" />
                Mover para direita
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator className="bg-[#2a2a3a]" />
            <DropdownMenuItem
              onClick={() => setIsStageSettingsOpen(true)}
              className="cursor-pointer focus:bg-[#2a2a3a] focus:text-white"
            >
              <Edit className="h-4 w-4 mr-2" />
              Renomear
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setIsStageSettingsOpen(true)}
              className="cursor-pointer focus:bg-[#2a2a3a] focus:text-white"
            >
              <Palette className="h-4 w-4 mr-2" />
              Mudar cor
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[#2a2a3a]" />
            <DropdownMenuItem
              onClick={handleDelete}
              className="cursor-pointer focus:bg-destructive focus:text-white text-destructive"
            >
              <Trash className="h-4 w-4 mr-2" />
              Excluir
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div ref={setNodeRef} className="flex-1 p-3 space-y-3 overflow-y-auto min-h-[150px]">
        {(Array.isArray(column.leads) ? column.leads : []).map((lead: any) => (
          <ErrorBoundary key={lead.id}>
            <LeadCard lead={lead} />
          </ErrorBoundary>
        ))}

        {column.leads.length === 0 && (
          <div className="h-24 border-2 border-dashed border-[#2a2a3a] rounded-xl flex flex-col items-center justify-center text-[#475569] text-[10px] p-4 text-center opacity-60">
            <LayoutGrid className="h-5 w-5 mb-2 opacity-20" />
            Arraste leads para cá
          </div>
        )}
      </div>

      <div className="p-3 bg-[#0d0d14]/50 border-t border-[#2a2a3a]">
        <Button
          variant="ghost"
          className="w-full justify-center text-[#475569] hover:text-[#7c3aed] hover:bg-[#7c3aed08] h-9 border border-dashed border-[#2a2a3a] rounded-lg text-xs"
          onClick={() => setIsLeadDialogOpen(true)}
        >
          <Plus className="h-3.5 w-3.5 mr-2" />
          Adicionar Lead
        </Button>
      </div>

      <LeadDialog
        open={isLeadDialogOpen}
        onOpenChange={setIsLeadDialogOpen}
        defaultStageId={column.id}
      />

      <StageDialog
        open={isStageSettingsOpen}
        onOpenChange={setIsStageSettingsOpen}
        stage={column}
        onUpdate={onUpdateStage}
        onDelete={onDeleteStage}
      />
    </div>
  );
}
