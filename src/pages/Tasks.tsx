import { useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Plus,
  Trash2,
  Pencil,
  CheckCircle2,
  Clock,
  AlertCircle,
  Calendar as CalendarIcon,
  Bot,
  ExternalLink,
  Inbox,
  Undo2,
  UserRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { format, formatDistanceToNow, isToday, isPast, isTomorrow } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  alternar,
  concluir,
  devolver,
  nomeDoResponsavel,
  ordenarTarefas,
  type Mudanca,
  type StatusTarefa,
} from "@/lib/tarefas";

type Task = {
  id: string;
  title: string;
  description: string | null;
  priority: "low" | "medium" | "high";
  status: StatusTarefa;
  due_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  origin: string;
  assignee_type: string;
  assignee_ref: string | null;
  result: string | null;
  result_ref: string | null;
  lead: { id: string; name: string } | null;
};

type Filtro = "all" | StatusTarefa;

const priorityConfig = {
  low: { label: "Baixa", color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  medium: { label: "Média", color: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
  high: { label: "Alta", color: "bg-red-500/15 text-red-400 border-red-500/30" },
};

const statusConfig: Record<StatusTarefa, { label: string; icon: LucideIcon; color: string }> = {
  aguardando_revisao: { label: "Aguardando revisão", icon: Inbox, color: "text-amber-300" },
  in_progress: { label: "Em andamento", icon: AlertCircle, color: "text-sky-400" },
  pending: { label: "Pendente", icon: Clock, color: "text-[#94a3b8]" },
  done: { label: "Concluída", icon: CheckCircle2, color: "text-green-400" },
};

const FILTROS: Array<{ chave: Filtro; rotulo: string }> = [
  { chave: "all", rotulo: "Todas" },
  { chave: "aguardando_revisao", rotulo: "Para revisar" },
  { chave: "pending", rotulo: "Pendentes" },
  { chave: "in_progress", rotulo: "Em andamento" },
  { chave: "done", rotulo: "Concluídas" },
];

const VAZIO: Record<Filtro, string> = {
  all: "Nenhuma tarefa ainda. Crie a primeira.",
  aguardando_revisao:
    "Nada esperando revisão. Quando um agente do Eleve Office entregar uma tarefa, ela aparece aqui.",
  pending: "Nenhuma tarefa pendente.",
  in_progress: "Nenhuma tarefa em andamento.",
  done: "Nenhuma tarefa concluída.",
};

function Etiqueta({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-[#1e1e2e] bg-[#12121c] px-2 py-0.5 text-xs text-[#94a3b8]">
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

function Resultado({
  texto,
  link,
  destaque,
}: {
  texto: string;
  link: string | null;
  destaque: boolean;
}) {
  const [aberto, setAberto] = useState(false);
  const longo = texto.length > 280;
  return (
    <div>
      <p
        className={`whitespace-pre-wrap text-sm ${
          destaque ? "border-l-2 border-[#f59e0b]/60 pl-3 text-[#e2e8f0]" : "text-[#94a3b8]"
        } ${longo && !aberto ? "line-clamp-4" : ""}`}
      >
        {texto}
      </p>
      {(longo || link) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs">
          {longo && (
            <button
              type="button"
              onClick={() => setAberto(!aberto)}
              className="text-[#94a3b8] underline-offset-2 hover:text-white hover:underline"
            >
              {aberto ? "Mostrar menos" : "Mostrar tudo"}
            </button>
          )}
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[#a78bfa] underline-offset-2 hover:underline"
            >
              <ExternalLink className="h-3 w-3" aria-hidden /> Abrir resultado
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export default function Tasks() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filtro>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [form, setForm] = useState({
    title: "",
    description: "",
    priority: "medium" as Task["priority"],
    status: "pending" as StatusTarefa,
    due_date: "",
  });

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["personal_tasks"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("personal_tasks")
        .select("*, lead:leads(id, name)");
      if (error) throw error;
      return ordenarTarefas(data as unknown as Task[]);
    },
  });

  const saveTask = useMutation({
    mutationFn: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Não autenticado");
      const payload = {
        user_id: user.id,
        title: form.title.trim(),
        description: form.description.trim() || null,
        priority: form.priority,
        status: form.status,
        due_date: form.due_date ? new Date(form.due_date).toISOString() : null,
        completed_at: form.status === "done" ? new Date().toISOString() : null,
      };
      if (editingTask) {
        const { error } = await supabase
          .from("personal_tasks")
          .update(payload)
          .eq("id", editingTask.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("personal_tasks").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["personal_tasks"] });
      toast.success(editingTask ? "Tarefa atualizada" : "Tarefa criada");
      closeDialog();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const mudarStatus = useMutation({
    mutationFn: async ({ task, mudanca }: { task: Task; mudanca: Mudanca; aviso?: string }) => {
      const { error } = await supabase.from("personal_tasks").update(mudanca).eq("id", task.id);
      if (error) throw error;
    },
    onSuccess: (_, { aviso }) => {
      queryClient.invalidateQueries({ queryKey: ["personal_tasks"] });
      if (aviso) toast.success(aviso);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteTask = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("personal_tasks").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["personal_tasks"] });
      toast.success("Tarefa removida");
    },
  });

  const openNew = () => {
    setEditingTask(null);
    setForm({ title: "", description: "", priority: "medium", status: "pending", due_date: "" });
    setDialogOpen(true);
  };

  const openEdit = (t: Task) => {
    setEditingTask(t);
    setForm({
      title: t.title,
      description: t.description || "",
      priority: t.priority,
      status: t.status,
      due_date: t.due_date ? t.due_date.slice(0, 16) : "",
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingTask(null);
  };

  const filtered = tasks.filter((t) => filter === "all" || t.status === filter);
  const paraRevisar = filtered.filter((t) => t.status === "aguardando_revisao");
  const demais = filtered.filter((t) => t.status !== "aguardando_revisao");
  const contagem = (f: Filtro) =>
    f === "all" ? tasks.length : tasks.filter((t) => t.status === f).length;

  const formatDue = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isToday(d)) return { label: `Hoje ${format(d, "HH:mm")}`, tone: "text-yellow-400" };
    if (isTomorrow(d)) return { label: `Amanhã ${format(d, "HH:mm")}`, tone: "text-blue-400" };
    if (isPast(d))
      return {
        label: `Atrasada — ${format(d, "dd/MM HH:mm", { locale: ptBR })}`,
        tone: "text-red-400",
      };
    return { label: format(d, "dd/MM HH:mm", { locale: ptBR }), tone: "text-[#94a3b8]" };
  };

  const renderRevisao = (t: Task) => (
    <Card
      key={t.id}
      className="relative overflow-hidden border-[#f59e0b]/30 bg-[#f59e0b]/[0.04] p-4 pl-5 hover:border-[#f59e0b]/60 hover:shadow-[#f59e0b]/10"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-[#f59e0b]" />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-amber-300/90">
            Entregue{" "}
            {formatDistanceToNow(new Date(t.updated_at), { addSuffix: true, locale: ptBR })}
            {t.assignee_type === "agente" ? ` por ${nomeDoResponsavel(t)}` : ""}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{t.title}</h3>
            <Badge variant="outline" className={priorityConfig[t.priority].color}>
              {priorityConfig[t.priority].label}
            </Badge>
          </div>
          {t.result && (
            <div className="mt-3">
              <Resultado texto={t.result} link={t.result_ref} destaque />
            </div>
          )}
          {t.lead && (
            <div className="mt-3">
              <Etiqueta icon={UserRound}>{t.lead.name}</Etiqueta>
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={mudarStatus.isPending}
            onClick={() =>
              mudarStatus.mutate({
                task: t,
                mudanca: devolver(),
                aviso: "Tarefa devolvida para o agente",
              })
            }
            className="border-[#2a2a3a] bg-transparent"
          >
            <Undo2 className="h-4 w-4 mr-1.5" /> Devolver
          </Button>
          <Button
            size="sm"
            disabled={mudarStatus.isPending}
            onClick={() =>
              mudarStatus.mutate({ task: t, mudanca: concluir(), aviso: "Tarefa concluída" })
            }
          >
            <CheckCircle2 className="h-4 w-4 mr-1.5" /> Concluir
          </Button>
        </div>
      </div>
    </Card>
  );

  const renderTarefa = (t: Task) => {
    const Icon = statusConfig[t.status].icon;
    const due = formatDue(t.due_date);
    const doOffice = t.origin === "eleve_office";
    const deAgente = t.assignee_type === "agente";
    return (
      <Card
        key={t.id}
        className={`p-4 bg-[#0d0d14] border-[#1e1e2e] hover:border-[#7c3aed]/30 transition ${
          t.status === "done" ? "opacity-60" : ""
        }`}
      >
        <div className="flex items-start gap-3">
          <Checkbox
            checked={t.status === "done"}
            onCheckedChange={() => mudarStatus.mutate({ task: t, mudanca: alternar(t.status) })}
            aria-label={t.status === "done" ? "Reabrir tarefa" : "Concluir tarefa"}
            className="mt-1"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3
                className={`font-semibold ${t.status === "done" ? "line-through text-[#94a3b8]" : ""}`}
              >
                {t.title}
              </h3>
              <Badge variant="outline" className={priorityConfig[t.priority].color}>
                {priorityConfig[t.priority].label}
              </Badge>
              <span className={`text-xs flex items-center gap-1 ${statusConfig[t.status].color}`}>
                <Icon className="h-3 w-3" /> {statusConfig[t.status].label}
              </span>
            </div>
            {t.description && (
              <p className="text-sm text-[#94a3b8] mt-1 whitespace-pre-wrap">{t.description}</p>
            )}
            {t.result && (
              <div className="mt-2 rounded-md bg-[#12121c] px-3 py-2">
                <p className="mb-1 text-xs font-medium text-[#94a3b8]">Última entrega</p>
                <Resultado texto={t.result} link={t.result_ref} destaque={false} />
              </div>
            )}
            {(due || doOffice || deAgente || t.lead) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {due && (
                  <span className={`mr-1 text-xs flex items-center gap-1 ${due.tone}`}>
                    <CalendarIcon className="h-3 w-3" /> {due.label}
                  </span>
                )}
                {doOffice && <Etiqueta icon={Workflow}>Eleve Office</Etiqueta>}
                {deAgente && <Etiqueta icon={Bot}>{nomeDoResponsavel(t)}</Etiqueta>}
                {t.lead && <Etiqueta icon={UserRound}>{t.lead.name}</Etiqueta>}
              </div>
            )}
          </div>
          <div className="flex gap-1">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Editar tarefa"
              onClick={() => openEdit(t)}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Remover tarefa"
              onClick={() => {
                if (confirm("Remover esta tarefa?")) deleteTask.mutate(t.id);
              }}
            >
              <Trash2 className="h-4 w-4 text-red-400" />
            </Button>
          </div>
        </div>
      </Card>
    );
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Minhas Tarefas</h1>
          <p className="text-sm text-[#94a3b8] mt-1">
            Sua rotina e as entregas dos agentes do Eleve Office.
          </p>
        </div>
        <Button onClick={openNew} className="bg-[#7c3aed] hover:bg-[#6d28d9]">
          <Plus className="h-4 w-4 mr-2" /> Nova tarefa
        </Button>
      </div>

      <div className="flex gap-2 flex-wrap">
        {FILTROS.map(({ chave, rotulo }) => {
          const n = contagem(chave);
          return (
            <button
              key={chave}
              type="button"
              onClick={() => setFilter(chave)}
              aria-pressed={filter === chave}
              className={`whitespace-nowrap px-3 py-1.5 rounded-lg text-sm font-medium border transition ${
                filter === chave
                  ? "bg-[#7c3aed15] text-[#7c3aed] border-[#7c3aed]/40"
                  : "bg-[#0d0d14] text-[#94a3b8] border-[#1e1e2e] hover:text-white"
              }`}
            >
              {chave === "aguardando_revisao" && n > 0 && (
                <span
                  aria-hidden
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[#f59e0b] align-middle"
                />
              )}
              {rotulo}
              <span className="ml-2 text-xs opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <p className="text-[#94a3b8]">Carregando…</p>
      ) : filtered.length === 0 ? (
        <Card className="p-12 text-center bg-[#0d0d14] border-[#1e1e2e]">
          <CheckCircle2 className="h-10 w-10 mx-auto text-[#475569] mb-3" />
          <p className="text-[#94a3b8]">{VAZIO[filter]}</p>
        </Card>
      ) : (
        <div className="space-y-8">
          {paraRevisar.length > 0 && (
            <section aria-labelledby="revisao-titulo" className="space-y-2">
              <h2
                id="revisao-titulo"
                className="flex items-center gap-2 text-sm font-semibold text-amber-200"
              >
                Esperando sua revisão
                <span className="rounded-full bg-[#f59e0b]/15 px-2 py-0.5 text-xs text-amber-300">
                  {paraRevisar.length}
                </span>
              </h2>
              {paraRevisar.map(renderRevisao)}
            </section>
          )}
          {demais.length > 0 && <div className="space-y-2">{demais.map(renderTarefa)}</div>}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent className="bg-[#0d0d14] border-[#1e1e2e]">
          <DialogHeader>
            <DialogTitle>{editingTask ? "Editar tarefa" : "Nova tarefa"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Título</label>
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Ex: Responder e-mails da manhã"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Descrição (opcional)</label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1.5 block">Prioridade</label>
                <Select
                  value={form.priority}
                  onValueChange={(v: Task["priority"]) => setForm({ ...form, priority: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Baixa</SelectItem>
                    <SelectItem value="medium">Média</SelectItem>
                    <SelectItem value="high">Alta</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">Status</label>
                <Select
                  value={form.status}
                  onValueChange={(v: StatusTarefa) => setForm({ ...form, status: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pendente</SelectItem>
                    <SelectItem value="in_progress">Em andamento</SelectItem>
                    {editingTask?.status === "aguardando_revisao" && (
                      <SelectItem value="aguardando_revisao">Aguardando revisão</SelectItem>
                    )}
                    <SelectItem value="done">Concluída</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Prazo (opcional)</label>
              <Input
                type="datetime-local"
                value={form.due_date}
                onChange={(e) => setForm({ ...form, due_date: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              Cancelar
            </Button>
            <Button
              onClick={() => saveTask.mutate()}
              disabled={!form.title.trim() || saveTask.isPending}
              className="bg-[#7c3aed] hover:bg-[#6d28d9]"
            >
              {saveTask.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
