import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface StageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stage?: any;
  onCreate?: (newStage: any) => void;
  onUpdate?: (updatedStage: any) => void;
  onDelete?: (stageId: string) => void;
  stagesCount?: number;
}

export function StageDialog({
  open,
  onOpenChange,
  stage,
  onCreate,
  onUpdate,
  onDelete,
  stagesCount = 0,
}: StageDialogProps) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#7c3aed");
  const [funnelKey, setFunnelKey] = useState("none");

  useEffect(() => {
    if (stage) {
      setName(stage.name);
      setColor(stage.color || "#7c3aed");
      setFunnelKey(stage.funnel_key || "none");
    } else {
      setName("");
      setColor("#7c3aed");
      setFunnelKey("none");
    }
  }, [stage, open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    if (stage) {
      const { data, error } = await supabase
        .from("pipeline_stages")
        .update({ name, color, funnel_key: funnelKey === "none" ? null : funnelKey })
        .eq("id", stage.id)
        .select()
        .single();

      if (error) {
        toast.error("Erro ao atualizar estágio");
      } else {
        onUpdate?.(data);
        toast.success("Estágio atualizado!");
        onOpenChange(false);
      }
    } else {
      const newPosition = stagesCount;

      const { data, error } = await supabase
        .from("pipeline_stages")
        .insert({
          name,
          color,
          funnel_key: funnelKey === "none" ? null : funnelKey,
          user_id: user.id,
          position: newPosition,
        })
        .select()
        .single();

      if (error) {
        toast.error("Erro ao criar estágio");
      } else {
        onCreate?.(data);
        toast.success("Estágio criado!");
        onOpenChange(false);
      }
    }
  };

  const handleDelete = async () => {
    if (
      stage &&
      window.confirm(
        "Tem certeza que deseja excluir este estágio? Leads vinculados ficarão sem estágio.",
      )
    ) {
      const { error } = await supabase.from("pipeline_stages").delete().eq("id", stage.id);
      if (error) {
        toast.error("Erro ao excluir estágio");
      } else {
        onDelete?.(stage.id);
        toast.success("Estágio excluído!");
        onOpenChange(false);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#111118] border-[#2a2a3a] text-white shadow-2xl">
        <DialogHeader>
          <DialogTitle>{stage ? "Editar Estágio" : "Novo Estágio"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Nome do Estágio</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="bg-[#0f0f0f] border-[#2a2a2a]"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="color">Cor</Label>
            <div className="flex gap-2">
              <Input
                id="color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-12 h-10 p-1 bg-[#0f0f0f] border-[#2a2a2a]"
              />
              <Input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="flex-1 bg-[#0f0f0f] border-[#2a2a2a]"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="funnel-key">Etapa do funil</Label>
            <Select value={funnelKey} onValueChange={setFunnelKey}>
              <SelectTrigger id="funnel-key" className="bg-[#0f0f0f] border-[#2a2a2a]">
                <SelectValue placeholder="Não classificar" />
              </SelectTrigger>
              <SelectContent className="bg-[#1a1a1a] border-[#2a2a2a]">
                <SelectItem value="none">Não classificar</SelectItem>
                <SelectItem value="prospecting">Prospecção</SelectItem>
                <SelectItem value="interested">Interessado</SelectItem>
                <SelectItem value="demo">Demonstração</SelectItem>
                <SelectItem value="proposal">Proposta</SelectItem>
                <SelectItem value="won">Venda ganha</SelectItem>
                <SelectItem value="lost">Venda perdida</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter className="flex justify-between items-center sm:justify-between">
            {stage && (
              <Button type="button" variant="destructive" onClick={handleDelete}>
                Excluir
              </Button>
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button type="submit" className="bg-[#7c3aed] hover:bg-[#6d28d9] font-bold">
                {stage ? "Salvar" : "Criar"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
