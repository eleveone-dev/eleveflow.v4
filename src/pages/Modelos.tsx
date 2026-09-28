import { useState } from "react";
import { CheckCircle2, Clock, Loader2, Plus, TriangleAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { cn } from "@/lib/utils";
import {
  useCreateTemplate,
  useTemplates,
  type Template,
  type TemplateCategory,
} from "@/hooks/use-templates";

/**
 * O status é decidido pela Meta, não por nós. Um template recém-criado nasce
 * PENDING e pode ser rejeitado depois — mostrar "criado com sucesso" como se
 * fosse aprovado enganaria quem depende dele para retomar conversas.
 */
function StatusBadge({ status }: { status: string }) {
  const normalizado = status.toUpperCase();

  if (normalizado === "APPROVED") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-[#34d399]">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        Aprovado
      </span>
    );
  }
  if (normalizado === "REJECTED" || normalizado === "DISABLED") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-[#f87171]">
        <XCircle className="h-3.5 w-3.5" aria-hidden />
        {normalizado === "REJECTED" ? "Recusado" : "Desativado"}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-[#fbbf24]">
      <Clock className="h-3.5 w-3.5" aria-hidden />
      {normalizado === "PENDING" ? "Em análise" : status}
    </span>
  );
}

function bodyOf(template: Template): string {
  const components = Array.isArray(template.components) ? template.components : [];
  const body = components.find((c) => (c as { type?: string })?.type?.toUpperCase() === "BODY") as
    | { text?: string }
    | undefined;
  return body?.text ?? "";
}

function NewTemplateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<TemplateCategory>("UTILITY");
  const [language, setLanguage] = useState("pt_BR");
  const [body, setBody] = useState("");
  const create = useCreateTemplate();

  const reset = () => {
    setName("");
    setCategory("UTILITY");
    setLanguage("pt_BR");
    setBody("");
    create.reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Novo modelo de mensagem</DialogTitle>
          <DialogDescription>
            O modelo é enviado à Meta para aprovação. Costuma levar de minutos a algumas horas.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="template-name">Nome</Label>
            <Input
              id="template-name"
              placeholder="boas_vindas"
              value={name}
              onChange={(event) => setName(event.target.value.toLowerCase())}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Só minúsculas, números e underscore. É o identificador, não o texto.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="template-category">Categoria</Label>
              <select
                id="template-category"
                value={category}
                onChange={(event) => setCategory(event.target.value as TemplateCategory)}
                className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm"
              >
                <option value="UTILITY">Utilidade</option>
                <option value="MARKETING">Marketing</option>
                <option value="AUTHENTICATION">Autenticação</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="template-language">Idioma</Label>
              <select
                id="template-language"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm"
              >
                <option value="pt_BR">Português (Brasil)</option>
                <option value="en_US">Inglês (EUA)</option>
                <option value="es_ES">Espanhol</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="template-body">Mensagem</Label>
            <textarea
              id="template-body"
              rows={4}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Olá! Passando para confirmar seu agendamento."
              className="w-full rounded-md border border-border bg-card p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-xs text-muted-foreground">{body.length}/1024 caracteres</p>
          </div>

          {create.isError && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {create.error.message}
            </p>
          )}

          <div className="flex justify-end pt-1">
            <Button
              onClick={() =>
                create.mutate(
                  { name, category, language, body },
                  {
                    onSuccess: () => {
                      reset();
                      onOpenChange(false);
                    },
                  },
                )
              }
              disabled={!name.trim() || !body.trim() || create.isPending}
              className="bg-[#7c3aed] hover:bg-[#6d28d9]"
            >
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Enviar para aprovação
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ModelosContent() {
  const { data: templates, isLoading, error } = useTemplates();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Modelos de mensagem</h1>
          <p className="text-sm text-muted-foreground">
            Aprovados pela Meta, usados para retomar conversas fora da janela de 24 horas.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)} className="bg-[#7c3aed] hover:bg-[#6d28d9]">
          <Plus className="mr-2 h-4 w-4" aria-hidden />
          Novo modelo
        </Button>
      </header>

      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
          <div>
            <p className="font-medium">Não foi possível listar os modelos</p>
            <p className="text-sm text-muted-foreground">{(error as Error).message}</p>
          </div>
        </div>
      )}

      {templates && templates.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p className="font-medium">Nenhum modelo criado</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Modelos permitem escrever para um contato depois que a janela de 24 horas fecha. Todo
            modelo passa por aprovação da Meta antes de poder ser usado.
          </p>
        </div>
      )}

      {templates && templates.length > 0 && (
        <ul className="space-y-3">
          {templates.map((template) => (
            <li
              key={template.id}
              className="rounded-xl border border-border bg-card p-5 transition-colors hover:border-muted-foreground/30"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-sm font-medium">{template.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {template.category} · {template.language}
                  </p>
                </div>
                <StatusBadge status={template.status} />
              </div>
              {bodyOf(template) && (
                <p
                  className={cn(
                    "mt-3 border-l-2 border-border pl-3 text-sm text-muted-foreground",
                    "whitespace-pre-wrap",
                  )}
                >
                  {bodyOf(template)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <NewTemplateDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

export default function Modelos() {
  return (
    <ErrorBoundary>
      <ModelosContent />
    </ErrorBoundary>
  );
}
