import { useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCheck,
  Clock,
  Contact,
  FileText,
  ImageIcon,
  Loader2,
  MapPin,
  Mic,
  Paperclip,
  Send,
  Smartphone,
  Sticker,
  TriangleAlert,
  Video,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { rotuloMidia } from "@/lib/midia-mensagem";
import { cn } from "@/lib/utils";
import {
  serviceWindow,
  useConversationMessages,
  useConversations,
  useHumanTakeover,
  useSendMessage,
  type ConversationMessage,
} from "@/hooks/use-conversations";

const horario = (iso: string) =>
  new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** Quanto falta para a pausa das automações vencer, em texto curto. */
const tempoRestante = (until: string) => {
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0) return "agora";

  const minutos = Math.ceil(ms / 60_000);
  if (minutos < 60) return `${minutos} min`;

  const horas = Math.floor(minutos / 60);
  const restoMin = minutos % 60;
  return restoMin > 0 ? `${horas}h${String(restoMin).padStart(2, "0")}` : `${horas}h`;
};

/**
 * Status de entrega confirmado pela Meta. Num CRM isso não é detalhe de canto:
 * saber se a mensagem chegou é o motivo de existir a tela. Por isso o ícone vem
 * acompanhado de rótulo, em vez de depender de o operador decorar os ticks.
 */
function DeliveryStatus({ status }: { status: string | null }) {
  if (status === "read") {
    return (
      <span className="flex items-center gap-1 text-[#7dd3fc]">
        <CheckCheck className="h-3 w-3" aria-hidden />
        lida
      </span>
    );
  }
  if (status === "delivered") {
    return (
      <span className="flex items-center gap-1 text-white/70">
        <CheckCheck className="h-3 w-3" aria-hidden />
        entregue
      </span>
    );
  }
  if (status === "sent") {
    return (
      <span className="flex items-center gap-1 text-white/70">
        <Check className="h-3 w-3" aria-hidden />
        enviada
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex items-center gap-1 text-[#fca5a5]">
        <TriangleAlert className="h-3 w-3" aria-hidden />
        falhou
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-white/60">
      <Clock className="h-3 w-3" aria-hidden />
      na fila
    </span>
  );
}

const ICONES_MIDIA: Record<string, LucideIcon> = {
  audio: Mic,
  image: ImageIcon,
  video: Video,
  document: FileText,
  sticker: Sticker,
  location: MapPin,
  contact: Contact,
};

function Bubble({ message }: { message: ConversationMessage }) {
  const enviada = message.direction === "outbound";
  const doCelular = enviada && message.origin === "business_app";
  const rotulo = rotuloMidia(message.mediaType);
  const IconeMidia = message.mediaType ? (ICONES_MIDIA[message.mediaType] ?? Paperclip) : null;

  return (
    <div className={cn("flex", enviada ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-4 py-2.5 text-sm",
          enviada
            ? "rounded-br-sm bg-[#7c3aed] text-white"
            : "rounded-bl-sm border border-border bg-card text-foreground",
        )}
      >
        {/* A mídia não é baixada: o tipo é o conteúdo que existe. */}
        {rotulo && IconeMidia && (
          <p
            className={cn(
              "flex items-center gap-2 font-medium",
              enviada ? "text-white/90" : "text-foreground/80",
            )}
          >
            <IconeMidia className="h-4 w-4 shrink-0" aria-hidden />
            {rotulo}
          </p>
        )}
        {message.content && (
          <p className={cn("whitespace-pre-wrap break-words", rotulo && "mt-1")}>
            {message.content}
          </p>
        )}
        <div
          className={cn(
            "mt-1 flex items-center gap-2 text-[11px]",
            enviada ? "justify-end text-white/70" : "text-muted-foreground",
          )}
        >
          <span>{horario(message.createdAt)}</span>
          {enviada && !doCelular && <DeliveryStatus status={message.status} />}
          {doCelular && (
            <span className="flex items-center gap-1 text-white/70">
              <Smartphone className="h-3 w-3" aria-hidden />
              pelo celular
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ConversasContent() {
  const { data: conversations, isLoading } = useConversations();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const { data: messages } = useConversationMessages(selected);
  const send = useSendMessage();
  const fim = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selected && conversations?.length) setSelected(conversations[0].leadId);
  }, [conversations, selected]);

  useEffect(() => {
    fim.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const atual = conversations?.find((c) => c.leadId === selected);
  const janela = serviceWindow(atual?.lastInboundAt ?? null);
  const takeover = useHumanTakeover(atual?.leadId ?? null);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }

  if (!conversations?.length) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-dashed border-border p-8 text-center">
        <h1 className="text-lg font-medium">Nenhuma conversa ainda</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          As conversas aparecem aqui quando um contato manda mensagem para o seu número, ou quando o
          CRM envia a primeira mensagem para um lead.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Conversas</h1>
        <p className="text-sm text-muted-foreground">
          Mensagens trocadas pelo WhatsApp oficial, com o status que a Meta confirmou.
        </p>
      </header>

      <div className="grid h-[70vh] grid-cols-1 gap-4 md:grid-cols-[280px_1fr]">
        <aside className="overflow-y-auto rounded-xl border border-border bg-card">
          {conversations.map((conversa) => (
            <button
              key={conversa.leadId}
              onClick={() => setSelected(conversa.leadId)}
              className={cn(
                "w-full border-b border-border px-4 py-3 text-left transition-colors last:border-b-0",
                selected === conversa.leadId ? "bg-[#7c3aed]/10" : "hover:bg-muted/40",
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">{conversa.name}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {horario(conversa.lastMessageAt)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {conversa.lastDirection === "outbound" && "Você: "}
                {conversa.lastContent}
              </p>
            </button>
          ))}
        </aside>

        <section className="flex min-w-0 flex-col rounded-xl border border-border bg-background">
          <div className="border-b border-border px-5 py-3">
            <p className="font-medium">{atual?.name}</p>
            <p className="text-xs text-muted-foreground">{atual?.phone ?? "sem telefone"}</p>
          </div>

          {/* O dono do negócio respondeu pelo WhatsApp Business App do celular: as
              automações ficam em pausa até o prazo marcado, e a IA não escreve por cima. */}
          {takeover.until && (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-3 border-b border-[#fbbf24]/30 bg-[#fbbf24]/[0.06] px-5 py-3 text-xs text-[#fbbf24]"
            >
              <span className="flex items-center gap-2">
                <Smartphone className="h-3.5 w-3.5 shrink-0" aria-hidden />
                IA pausada — você assumiu esta conversa pelo celular. Volta em{" "}
                {tempoRestante(takeover.until)}.
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={takeover.release.isPending}
                onClick={() => takeover.release.mutate()}
                className="shrink-0"
              >
                {takeover.release.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                )}
                Devolver para a IA
              </Button>
            </div>
          )}

          <div className="flex-1 space-y-3 overflow-y-auto p-5">
            {messages?.map((message) => (
              <Bubble key={message.id} message={message} />
            ))}
            <div ref={fim} />
          </div>

          {/* A janela de 24h é regra da Meta, não escolha do produto: fora dela
              só template passa, e o operador precisa saber antes de escrever. */}
          {!janela.open && (
            <p className="flex items-start gap-2 border-t border-[#fbbf24]/30 bg-[#fbbf24]/[0.06] px-5 py-3 text-xs text-[#fbbf24]">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Janela de 24 horas encerrada. Só mensagens de template são aceitas até o contato
              escrever de novo.
            </p>
          )}

          <form
            className="flex items-center gap-2 border-t border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!selected || !draft.trim()) return;
              send.mutate(
                { leadId: selected, content: draft.trim() },
                { onSuccess: () => setDraft("") },
              );
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={janela.open ? "Escreva uma mensagem" : "Fora da janela de 24 horas"}
              className="h-11 flex-1 rounded-lg border border-border bg-card px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              type="submit"
              disabled={!draft.trim() || send.isPending}
              className="h-11 shrink-0 bg-[#7c3aed] hover:bg-[#6d28d9]"
            >
              {send.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Send className="h-4 w-4" aria-hidden />
              )}
              <span className="sr-only">Enviar</span>
            </Button>
          </form>

          {send.isError && (
            <p className="flex items-start gap-2 px-5 pb-3 text-xs text-destructive">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {send.error.message}
            </p>
          )}
        </section>
      </div>

      {janela.open && janela.hoursLeft !== null && (
        <p className="text-xs text-muted-foreground">
          Janela de atendimento aberta — restam cerca de {janela.hoursLeft}h para responder sem
          template.
        </p>
      )}
    </div>
  );
}

export default function Conversas() {
  return (
    <ErrorBoundary>
      <ConversasContent />
    </ErrorBoundary>
  );
}
