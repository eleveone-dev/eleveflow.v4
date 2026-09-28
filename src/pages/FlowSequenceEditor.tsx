import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Play, Save, Plus, Trash2, Sliders } from "lucide-react";
import { useFlow } from "@/hooks/use-flows";
import { useStages } from "@/hooks/use-crm";
import { handleError } from "@/utils/error-handler";
import { FlowSequence, emptySequence, readSequence, WaitUnit } from "@/lib/flow-sequence-types";
import { normalizeBrazilPhone } from "@/lib/phone";

export default function FlowSequenceEditor() {
  const { id } = useParams({ from: "/flows/$id/edit" }) as { id: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: flow, isLoading } = useFlow(id);
  const { data: stages } = useStages();

  const [seq, setSeq] = useState<FlowSequence>(emptySequence());
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!flow || initialized) return;
    const existing = readSequence((flow as any).canvas_state);
    if (existing) {
      setSeq({
        ...existing,
        on_reply: {
          messages: existing.on_reply?.messages?.length ? existing.on_reply.messages : [""],
        },
      });
    } else {
      const init = emptySequence();
      if ((flow as any).trigger_stage_id) {
        init.trigger = { type: "stage_enter", stage_id: (flow as any).trigger_stage_id };
      }
      setSeq(init);
    }
    setInitialized(true);
  }, [flow, initialized]);

  const mutate = (updater: (s: FlowSequence) => FlowSequence) => {
    setSeq((s) => updater({ ...s }));
    setDirty(true);
  };

  const handleSave = async () => {
    const t = toast.loading("Salvando fluxo...");
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Não autenticado");

      const cleanSeq: FlowSequence = {
        ...seq,
        on_reply: { messages: seq.on_reply.messages.filter((m) => m && m.trim()) },
      };
      if (seq.on_no_reply) {
        const msgs = (seq.on_no_reply.messages || []).filter((m) => m && m.trim());
        cleanSeq.on_no_reply = msgs.length ? { ...seq.on_no_reply, messages: msgs } : undefined;
      }

      const triggerStageId = seq.trigger.type === "stage_enter" ? seq.trigger.stage_id : null;

      await supabase
        .from("flows")
        .update({
          canvas_state: { mode: "sequence", sequence: cleanSeq } as any,
          trigger_stage_id: triggerStageId,
          trigger_type: triggerStageId ? "stage_enter" : "manual",
        } as any)
        .eq("id", id);

      await supabase.from("flow_blocks").delete().eq("flow_id", id);

      queryClient.invalidateQueries({ queryKey: ["flows", id] });
      queryClient.invalidateQueries({ queryKey: ["flows"] });
      setDirty(false);
      toast.dismiss(t);
      toast.success("Fluxo salvo!");
    } catch (e: any) {
      toast.dismiss(t);
      handleError(e, "FlowSequenceEditor:handleSave");
    }
  };

  const handleTest = async () => {
    const t = toast.loading("Iniciando teste real...");
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Não autenticado");

      const { data: account } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", user.id)
        .single();
      if (!account) throw new Error("Conta não encontrada");
      const settings: any = account.settings || {};
      const testPhone = settings.test_phone;
      if (!testPhone) {
        toast.dismiss(t);
        toast.error("Configure o telefone de teste nas configurações.");
        navigate({ to: "/settings" as any });
        return;
      }
      if ((account as any).whatsapp_status !== "connected") {
        toast.dismiss(t);
        toast.error("WhatsApp desconectado.");
        return;
      }

      const normalized = normalizeBrazilPhone(testPhone);
      const { data: lead, error: leadErr } = await supabase
        .from("leads")
        .insert({
          user_id: user.id,
          name: "Teste EleveFlow",
          phone: normalized,
          company: "Teste Sequência",
          tags: ["teste-sequence"],
          marketing_consent_status: "not_required",
        })
        .select()
        .single();
      if (leadErr) throw leadErr;

      await handleSave();

      const { data, error } = await supabase.functions.invoke("execute-sequence", {
        body: { action: "start", flow_id: id, lead_id: lead.id, user_id: user.id, is_test: true },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);

      toast.dismiss(t);
      toast.success("M1 enfileirada. Responda no WhatsApp para acionar M2/M3.");

      setTimeout(() => supabase.from("leads").delete().eq("id", lead.id), 5 * 60 * 1000);
    } catch (e: any) {
      toast.dismiss(t);
      handleError(e, "FlowSequenceEditor:handleTest");
    }
  };

  if (isLoading) return <div className="p-10 text-white">Carregando...</div>;

  const replyMsgs = seq.on_reply.messages;

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <header className="h-14 flex justify-between items-center px-6 border-b border-[#2a2a3a] bg-[#111118] sticky top-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/flows" as any })}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="font-semibold truncate text-sm">{flow?.name}</h1>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            navigate({ to: "/flows/$id/edit", params: { id }, search: { mode: "advanced" } } as any)
          }
          className="text-slate-500 hover:text-slate-300 text-xs"
        >
          <Sliders className="h-3.5 w-3.5 mr-1.5" /> Modo Avançado
        </Button>
      </header>

      <main className="max-w-xl mx-auto py-10 px-4 pb-32">
        <h2 className="text-2xl font-bold mb-1">Fluxo: {flow?.name}</h2>
        <div className="h-px bg-[#2a2a3a] my-6" />

        {/* Disparo */}
        <Section label="Disparo">
          <label className="block text-sm text-slate-300 mb-2">Quando lead entrar na etapa:</label>
          <Select
            value={seq.trigger.type === "stage_enter" ? seq.trigger.stage_id : "__manual"}
            onValueChange={(v) =>
              mutate((s) => {
                s.trigger =
                  v === "__manual" ? { type: "manual" } : { type: "stage_enter", stage_id: v };
                return s;
              })
            }
          >
            <SelectTrigger className="bg-[#0d0d14] border-[#2a2a3a] h-10">
              <SelectValue placeholder="Selecione uma etapa" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__manual">Disparo manual (sem gatilho)</SelectItem>
              {(stages || []).map((s: any) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Section>

        {/* M1 */}
        <MessageCard
          title="Mensagem 1 — M1"
          value={seq.m1.message}
          onChange={(v) =>
            mutate((s) => {
              s.m1.message = v;
              return s;
            })
          }
          placeholder="Olá {{nome}}, ..."
        />

        {/* M2..Mn */}
        {replyMsgs.map((m, i) => (
          <React.Fragment key={i}>
            <Divider
              text={
                i === 0 ? "Depois que o lead responder qualquer coisa" : "Enviar logo em seguida"
              }
            />
            <MessageCard
              title={`Mensagem ${i + 2} — M${i + 2}`}
              value={m}
              onChange={(v) =>
                mutate((s) => {
                  s.on_reply.messages = [...s.on_reply.messages];
                  s.on_reply.messages[i] = v;
                  return s;
                })
              }
              onRemove={
                replyMsgs.length > 1
                  ? () =>
                      mutate((s) => {
                        s.on_reply.messages = s.on_reply.messages.filter((_, j) => j !== i);
                        return s;
                      })
                  : undefined
              }
              placeholder={`Mensagem ${i + 2}`}
            />
          </React.Fragment>
        ))}

        <div className="mt-3">
          <button
            onClick={() =>
              mutate((s) => {
                s.on_reply.messages = [...s.on_reply.messages, ""];
                return s;
              })
            }
            className="text-xs text-slate-400 hover:text-white inline-flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /> adicionar mensagem
          </button>
        </div>

        {/* Se não responder */}
        <Divider text="Se não responder" className="mt-10" />

        {!seq.on_no_reply ? (
          <button
            onClick={() =>
              mutate((s) => {
                s.on_no_reply = { wait_value: 24, wait_unit: "hours", messages: [""] };
                return s;
              })
            }
            className="text-xs text-slate-400 hover:text-white inline-flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /> configurar follow-up
          </button>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-4 text-sm text-slate-300">
              <span>Aguardar</span>
              <Input
                type="number"
                min={1}
                value={seq.on_no_reply.wait_value}
                onChange={(e) =>
                  mutate((s) => {
                    if (s.on_no_reply) s.on_no_reply.wait_value = Number(e.target.value) || 1;
                    return s;
                  })
                }
                className="w-20 h-9 bg-[#0d0d14] border-[#2a2a3a]"
              />
              <Select
                value={seq.on_no_reply.wait_unit}
                onValueChange={(v) =>
                  mutate((s) => {
                    if (s.on_no_reply) s.on_no_reply.wait_unit = v as WaitUnit;
                    return s;
                  })
                }
              >
                <SelectTrigger className="bg-[#0d0d14] border-[#2a2a3a] w-28 h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">Minutos</SelectItem>
                  <SelectItem value="hours">Horas</SelectItem>
                  <SelectItem value="days">Dias</SelectItem>
                </SelectContent>
              </Select>
              <button
                onClick={() =>
                  mutate((s) => {
                    s.on_no_reply = undefined;
                    return s;
                  })
                }
                className="ml-auto text-[11px] text-slate-500 hover:text-red-400"
              >
                remover follow-up
              </button>
            </div>

            {seq.on_no_reply.messages.map((m, i) => (
              <MessageCard
                key={i}
                title={seq.on_no_reply!.messages.length > 1 ? `Follow-up ${i + 1}` : "Follow-up"}
                value={m}
                onChange={(v) =>
                  mutate((s) => {
                    if (!s.on_no_reply) return s;
                    const next = [...s.on_no_reply.messages];
                    next[i] = v;
                    s.on_no_reply = { ...s.on_no_reply, messages: next };
                    return s;
                  })
                }
                onRemove={
                  (seq.on_no_reply?.messages.length ?? 0) > 1
                    ? () =>
                        mutate((s) => {
                          if (!s.on_no_reply) return s;
                          s.on_no_reply = {
                            ...s.on_no_reply,
                            messages: s.on_no_reply.messages.filter((_, j) => j !== i),
                          };
                          return s;
                        })
                    : undefined
                }
                placeholder="Texto do follow-up"
              />
            ))}

            <div className="mt-3">
              <button
                onClick={() =>
                  mutate((s) => {
                    if (!s.on_no_reply) return s;
                    s.on_no_reply = { ...s.on_no_reply, messages: [...s.on_no_reply.messages, ""] };
                    return s;
                  })
                }
                className="text-xs text-slate-400 hover:text-white inline-flex items-center gap-1"
              >
                <Plus className="h-3 w-3" /> adicionar follow-up
              </button>
            </div>
          </>
        )}

        {/* Ações */}
        <div className="h-px bg-[#2a2a3a] my-10" />
        <div className="flex gap-3">
          <Button
            onClick={handleSave}
            className={`flex-1 h-11 ${dirty ? "bg-orange-500 hover:bg-orange-600 animate-pulse" : "bg-[#7c3aed] hover:bg-[#6d28d9]"}`}
          >
            <Save className="h-4 w-4 mr-2" /> {dirty ? "Salvar fluxo*" : "Salvar fluxo"}
          </Button>
          <Button
            variant="outline"
            onClick={handleTest}
            className="flex-1 h-11 border-[#2a2a3a] text-slate-200 hover:text-white bg-transparent"
          >
            <Play className="h-4 w-4 mr-2 text-green-500" /> Testar fluxo
          </Button>
        </div>

        <p className="text-[10px] text-slate-600 mt-6 text-center">
          Variáveis disponíveis: {"{{nome}}"} {"{{empresa}}"} {"{{telefone}}"}
        </p>
      </main>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500 mb-3 font-semibold">
        {label}
      </div>
      {children}
    </div>
  );
}

function Divider({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`flex items-center gap-3 my-6 ${className}`}>
      <div className="h-px bg-[#2a2a3a] flex-1" />
      <span className="text-[11px] uppercase tracking-[0.15em] text-slate-500 font-medium whitespace-nowrap">
        {text}
      </span>
      <div className="h-px bg-[#2a2a3a] flex-1" />
    </div>
  );
}

function MessageCard({
  title,
  value,
  onChange,
  onRemove,
  placeholder,
}: {
  title: string;
  value: string;
  onChange: (v: string) => void;
  onRemove?: () => void;
  placeholder?: string;
}) {
  return (
    <div className="rounded-lg border border-[#2a2a3a] bg-[#111118] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#2a2a3a]">
        <span className="text-sm font-semibold text-slate-200">{title}</span>
        {onRemove && (
          <button
            onClick={onRemove}
            className="text-slate-500 hover:text-red-400 p-1"
            aria-label="Remover"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-h-[140px] bg-transparent border-0 rounded-none text-white focus-visible:ring-0 resize-none"
      />
    </div>
  );
}
