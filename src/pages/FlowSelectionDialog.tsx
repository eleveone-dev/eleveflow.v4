import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useExecuteFlow } from "@/hooks/use-crm";
import { Play } from "lucide-react";

interface FlowSelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
}

export function FlowSelectionDialog({ open, onOpenChange, leadId }: FlowSelectionDialogProps) {
  const [selectedFlowId, setSelectedFlowId] = useState<string>("");
  const executeFlow = useExecuteFlow();

  const { data: flows, isLoading } = useQuery({
    queryKey: ["flows", "active"],
    queryFn: async () => {
      const { data, error } = await supabase.from("flows").select("*").eq("is_active", true);
      if (error) throw error;
      return data;
    },
    enabled: open,
  });

  const handleStartFlow = async () => {
    if (!selectedFlowId) return;
    await executeFlow.mutateAsync({ leadId, flowId: selectedFlowId });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#111118] border-[#2a2a2a] text-white shadow-2xl">
        <DialogHeader>
          <DialogTitle>Iniciar Fluxo para o Lead</DialogTitle>
        </DialogHeader>

        <div className="py-4">
          <label className="text-sm text-[#94a3b8] mb-2 block">Selecione o Fluxo</label>
          <Select value={selectedFlowId} onValueChange={setSelectedFlowId}>
            <SelectTrigger className="bg-[#0f0f0f] border-[#2a2a2a]">
              <SelectValue placeholder="Escolha um fluxo ativo..." />
            </SelectTrigger>
            <SelectContent className="bg-[#111118] border-[#2a2a3a]">
              {flows?.map((flow) => (
                <SelectItem key={flow.id} value={flow.id}>
                  {flow.name}
                </SelectItem>
              ))}
              {flows?.length === 0 && !isLoading && (
                <div className="p-2 text-center text-xs text-[#64748b]">
                  Nenhum fluxo ativo encontrado
                </div>
              )}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={handleStartFlow}
            disabled={!selectedFlowId || executeFlow.isPending}
            className="bg-[#7c3aed] hover:bg-[#6d28d9] font-bold"
          >
            {executeFlow.isPending ? (
              "Iniciando..."
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                Iniciar Fluxo
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
