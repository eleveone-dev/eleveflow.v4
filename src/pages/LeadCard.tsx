import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Badge } from "@/components/ui/badge";
import {
  Phone,
  Building2,
  Tag,
  Loader2,
  MapPin,
  AtSign,
  Globe,
  MessageCircle,
  ClipboardCopy,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { safeText } from "@/lib/utils/safeData";
// Mesma regra do servidor, importada do módulo compartilhado: duas cópias da
// regra divergiriam, e a tela passaria a dizer o contrário do que o fluxo faz.
import { canReceiveWhatsApp } from "../../supabase/functions/_shared/whatsapp/phone-target";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { buildLeadBriefForChatGPT } from "@/lib/leadBrief";

export function LeadCard({ lead }: { lead: any }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead.id,
  });
  const [enriching, setEnriching] = useState(false);

  const handleCopyBrief = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(buildLeadBriefForChatGPT(lead));
      toast.success("Dados copiados! Cole no ChatGPT.");
    } catch {
      toast.error("Falha ao copiar.");
    }
  };

  const handleEnrich = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (enriching) return;
    setEnriching(true);
    const t = toast.loading("Enriquecendo lead...");
    try {
      const { data, error } = await supabase.functions.invoke("enrich-lead", {
        body: { lead_id: lead.id },
      });
      if (error) throw error;
      if (data?.processed) toast.success("Lead enriquecido!", { id: t });
      else toast.error(data?.message || "Falhou", { id: t });
    } catch (err: any) {
      toast.error("Erro: " + (err?.message || "desconhecido"), { id: t });
    } finally {
      setEnriching(false);
    }
  };

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
  };

  const getLeadSource = (l: any) =>
    String(l.source || l.origin || l.lead_source || "")
      .trim()
      .toLowerCase();

  const leadSource = getLeadSource(lead);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="bg-[#1a1a24] p-4 rounded-xl border border-[#2a2a3a] shadow-sm hover:border-[#7c3aed] hover:shadow-lg hover:shadow-[#7c3aed08] transition-all cursor-grab active:cursor-grabbing group select-none relative"
    >
      <div className="flex flex-col space-y-2.5">
        <div className="flex justify-between items-start">
          <div className="flex flex-col gap-1">
            <h4 className="font-bold text-sm text-white group-hover:text-[#7c3aed] transition-colors leading-tight">
              {safeText(lead.name)}
            </h4>
            {leadSource === "extrator-google" && (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  width: "fit-content",
                  padding: "1px 6px",
                  borderRadius: "4px",
                  fontSize: "10px",
                  fontWeight: 500,
                  lineHeight: "14px",
                  color: "#8B5CF6",
                  background: "rgba(139, 92, 246, 0.08)",
                  border: "1px solid rgba(139, 92, 246, 0.18)",
                  marginTop: "2px",
                }}
              >
                extrator-google
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            {Array.isArray(lead.flow_executions) &&
              lead.flow_executions?.some((ex: any) => ex.status === "running") && (
                <div
                  className="h-2 w-2 rounded-full bg-[#7c3aed] shadow-[0_0_8px_#7c3aed]"
                  title="Fluxo Ativo"
                />
              )}
            {lead.enriched_at && (
              <div className="h-2 w-2 rounded-full bg-green-500" title="Lead enriquecido" />
            )}
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={handleCopyBrief}
              title="Copiar dados para ChatGPT"
              className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 rounded-md flex items-center justify-center bg-[#0d0d14] border border-[#2a2a3a] hover:border-[#7c3aed] hover:text-[#7c3aed] text-[#94a3b8]"
            >
              <ClipboardCopy className="h-3 w-3" />
            </button>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={handleEnrich}
              disabled={enriching}
              title="Enriquecer dados (fotos, sobre, avaliações)"
              className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 rounded-md flex items-center justify-center bg-[#0d0d14] border border-[#2a2a3a] hover:border-amber-400 hover:text-amber-400 text-[#94a3b8]"
            >
              {enriching ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3" />
              )}
            </button>
          </div>
        </div>

        {lead.company && (
          <div className="flex items-center text-[11px] text-[#475569] font-medium">
            <Building2 className="h-3 w-3 mr-1.5 opacity-60" />
            {safeText(lead.company)}
          </div>
        )}

        <div className="flex items-center text-[11px] text-[#475569] font-medium">
          <Phone className="h-3 w-3 mr-1.5 opacity-60" />
          {safeText(lead.phone)}
        </div>

        {/* Mesma regra que o fluxo usa para recusar o envio — não as flags do
            lead, que têm DEFAULT false no banco e diriam "sem WhatsApp" para
            qualquer cadastro que não as preencheu. */}
        {(() => {
          const alvo = canReceiveWhatsApp(lead);
          if (alvo.ok) return null;
          return (
            <div className="flex items-start gap-1.5 text-[11px] text-[#b45309]">
              <TriangleAlert className="mt-[2px] h-3 w-3 shrink-0" aria-hidden />
              <span>
                {alvo.reason === "landline"
                  ? "Este número parece ser fixo, não WhatsApp."
                  : "Este número está incompleto (falta DDD)."}{" "}
                O fluxo não envia para ele.
              </span>
            </div>
          );
        })()}

        {(() => {
          const phoneDigits = String(lead.whatsapp || lead.phone || "").replace(/\D/g, "");
          const waUrl = phoneDigits
            ? `https://wa.me/${phoneDigits.startsWith("55") ? phoneDigits : `55${phoneDigits}`}`
            : null;
          const mapsUrl =
            lead.maps_url ||
            (lead.place_id
              ? `https://www.google.com/maps/place/?q=place_id:${lead.place_id}`
              : null) ||
            (lead.address
              ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lead.address)}`
              : null);
          const websiteUrl = lead.website
            ? String(lead.website).startsWith("http")
              ? lead.website
              : `https://${lead.website}`
            : null;
          const instagramUrl = lead.instagram_url || null;
          const links = [
            waUrl && { url: waUrl, icon: MessageCircle, label: "WhatsApp", color: "#25D366" },
            mapsUrl && {
              url: mapsUrl,
              icon: MapPin,
              label: "Google Maps / Meu Negócio",
              color: "#4285F4",
            },
            websiteUrl && { url: websiteUrl, icon: Globe, label: "Site", color: "#94a3b8" },
            instagramUrl && {
              url: instagramUrl,
              icon: AtSign,
              label: "Instagram",
              color: "#E1306C",
            },
          ].filter(Boolean) as { url: string; icon: any; label: string; color: string }[];
          if (links.length === 0) return null;
          return (
            <div className="flex items-center gap-1.5 pt-1">
              {links.map((l) => {
                const Icon = l.icon;
                return (
                  <a
                    key={l.label}
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={l.label}
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    className="h-6 w-6 rounded-md flex items-center justify-center bg-[#0d0d14] border border-[#2a2a3a] hover:border-[#7c3aed] transition-colors"
                    style={{ color: l.color }}
                  >
                    <Icon className="h-3 w-3" />
                  </a>
                );
              })}
            </div>
          );
        })()}

        {Array.isArray(lead.tags) && lead.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {lead.tags.map((tag: string) => (
              <Badge
                key={tag}
                variant="secondary"
                className="bg-[#0d0d14] text-[#475569] text-[9px] px-1.5 py-0 border-[#2a2a3a] group-hover:text-[#94a3b8] transition-colors"
              >
                <Tag className="h-2 w-2 mr-1" />
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
