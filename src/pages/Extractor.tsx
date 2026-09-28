import React, { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { safeText } from "@/lib/utils/safeData";
import { toast } from "sonner";

export default function Extractor() {
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Filtros de busca
  const [filtroSite, setFiltroSite] = useState("todos");
  const [filtroContato, setFiltroContato] = useState("todos");
  const [limite, setLimite] = useState(20);
  const [isMovingMass, setIsMovingMass] = useState(false);

  // Filtro de exibição (client-side)
  const [viewFilter, setViewFilter] = useState("all");

  const cleanPhone = (value: any) => {
    if (!value) return "";
    return String(value).replace(/\D/g, "");
  };

  const isValidBrazilPhone = (value: any) => {
    const phone = cleanPhone(value);
    // Remove DDI 55 se existir
    const normalized = phone.startsWith("55") ? phone.slice(2) : phone;
    // Celular BR geralmente tem 11 dígitos: DDD + 9 + número
    // Fixo geralmente tem 10 dígitos: DDD + número
    return normalized.length === 10 || normalized.length === 11;
  };

  const isLikelyWhatsApp = (value: any) => {
    const phone = cleanPhone(value);
    const normalized = phone.startsWith("55") ? phone.slice(2) : phone;
    // WhatsApp no Brasil normalmente é celular:
    // 11 dígitos, sendo DDD + 9 + número
    return normalized.length === 11 && normalized[2] === "9";
  };

  const normalizeLead = (rawLead: any) => {
    const phoneValue =
      rawLead.phone || rawLead.phone_number || rawLead.telefone || rawLead.whatsapp || "";
    const cleaned = cleanPhone(phoneValue);
    const normalizedPhone = cleaned.startsWith("55") ? cleaned : cleaned ? `55${cleaned}` : "";

    const placeId = rawLead.place_id || null;
    const mapsUrl =
      rawLead.maps_url ||
      (placeId ? `https://www.google.com/maps/place/?q=place_id:${placeId}` : "");

    // Detecta Instagram em website ou string solta
    let instagram = rawLead.instagram_url || "";
    const websiteRaw = rawLead.website || rawLead.site || "";
    if (!instagram && /instagram\.com\//i.test(String(websiteRaw))) {
      const m = String(websiteRaw).match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
      if (m) instagram = `https://www.instagram.com/${m[1].replace(/\/$/, "")}`;
    }

    return {
      id: String(rawLead.id || rawLead.place_id || crypto.randomUUID()),
      name: safeText(rawLead.name || rawLead.title || "Sem nome"),
      phone: safeText(phoneValue),
      cleanPhone: safeText(normalizedPhone),
      whatsapp: isLikelyWhatsApp(phoneValue) ? safeText(normalizedPhone) : "",
      hasValidPhone: isValidBrazilPhone(phoneValue),
      isLikelyWhatsapp: isLikelyWhatsApp(phoneValue),
      website: safeText(websiteRaw),
      address: safeText(rawLead.address || rawLead.endereco || ""),
      category: safeText(rawLead.category || rawLead.type || ""),
      rating: safeText(rawLead.rating || ""),
      place_id: safeText(placeId || ""),
      maps_url: safeText(mapsUrl),
      instagram_url: safeText(instagram),
      cover_photo_url: safeText(rawLead.cover_photo_url || rawLead.thumbnail || ""),
      isMoved: Boolean(rawLead.isMoved || rawLead.alreadyMoved || false),
      raw: rawLead,
    };
  };

  const handleSearch = async () => {
    if (loading) return;
    const q = String(query || "").trim();
    const c = String(city || "").trim();
    if (!q || !c) {
      setError("Informe o nicho e a cidade antes de buscar.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke("google-extractor", {
        body: {
          query: q,
          city: c,
          filters: { site: filtroSite, contact: filtroContato },
          limit: limite,
        },
      });

      if (invokeError) throw invokeError;

      const rawResults = Array.isArray(data?.results) ? data.results : [];
      const normalized = rawResults.map((r: any) => normalizeLead(r));
      setResults(normalized);
    } catch (e: any) {
      console.error("[Extractor] busca falhou:", e);
      setError("Erro ao buscar: " + (e?.message || "falha desconhecida"));
    } finally {
      setLoading(false);
    }
  };

  const handleMoveToLeads = async (lead: any) => {
    if (!lead?.id || !lead?.name) {
      console.warn("[Extractor] lead inválido para mover", lead);
      return;
    }
    try {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Usuário não autenticado");

      // Bloquear duplicado por telefone normalizado
      const normPhone = String(lead.phone ?? "").replace(/\D/g, "");
      if (normPhone) {
        const { data: existing } = await supabase
          .from("leads")
          .select("phone")
          .eq("user_id", userData.user.id);
        if (
          (existing || []).some((l: any) => String(l.phone ?? "").replace(/\D/g, "") === normPhone)
        ) {
          toast.info("Lead já existe no CRM (telefone duplicado).");
          return;
        }
      }

      // Buscar o ID da etapa "Prospecção"
      const { data: stageData } = await supabase
        .from("pipeline_stages")
        .select("id")
        .eq("name", "Prospecção")
        .eq("user_id", userData.user.id)
        .limit(1)
        .single();

      const leadData = {
        user_id: userData.user.id,
        name: lead.name,
        phone: lead.phone,
        whatsapp: lead.isLikelyWhatsapp ? lead.cleanPhone : null,
        has_whatsapp: lead.isLikelyWhatsapp,
        phone_valid: lead.hasValidPhone,
        website: lead.website,
        address: lead.address,
        category: lead.category,
        place_id: lead.place_id || null,
        maps_url: lead.maps_url || null,
        instagram_url: lead.instagram_url || null,
        cover_photo_url: lead.cover_photo_url || null,
        stage_id: stageData?.id || null,
        source: "extrator-google",
        // Sem isto o lead nasce `unknown` e o fluxo recusa enfileirar:
        // `assertLeadCanReceiveMarketing` exige `granted` ou `not_required`.
        // Contato comercial de empresa, a partir de dado público do Google Maps.
        // O opt-out continua valendo — ele grava `withdrawn` e suprime.
        marketing_consent_status: "not_required",
        marketing_consent_source: "extrator-google",
      };

      const { data: insertedLead, error: insertError } = await supabase
        .from("leads")
        .insert([leadData])
        .select()
        .single();

      if (insertError) throw insertError;

      const { error: touchpointError } = await supabase.from("touchpoints").insert({
        user_id: userData.user.id,
        lead_id: insertedLead.id,
        channel: "google_maps",
        touch_type: "lead_imported",
        metadata: {
          source: "extrator-google",
          place_id: lead.place_id || null,
          query: String(query || "").trim() || null,
          city: String(city || "").trim() || null,
        },
      });
      if (touchpointError) {
        console.warn("[Extractor] touchpoint nÃ£o registrado:", touchpointError);
        toast.warning("Lead importado, mas não foi possível registrar a origem para métricas.");
      }

      // Marcar como movido localmente
      setResults((prev) => prev.map((r) => (r.id === lead.id ? { ...r, isMoved: true } : r)));

      // Auto-enriquecimento (fire-and-forget) — fotos, sobre, avaliações, instagram
      if (insertedLead?.id) {
        supabase.functions
          .invoke("enrich-lead", { body: { lead_id: insertedLead.id } })
          .then((r) => {
            if ((r as any)?.data?.processed) {
              console.log(`[Extractor] lead ${insertedLead.id} enriquecido`);
            }
          })
          .catch((err) => console.warn("[Extractor] enrich falhou:", err));
      }
    } catch (e: any) {
      console.error("[Extractor] mover lead falhou:", e);
      alert("Erro ao mover lead: " + (e?.message || "falha desconhecida"));
    }
  };

  const filtered = results.filter((r) => {
    if (viewFilter === "whatsapp") return r.isLikelyWhatsapp === true;
    if (viewFilter === "new") return !r.isMoved;
    return true;
  });

  return (
    <div
      style={{
        padding: 24,
        background: "#000",
        color: "#fff",
        minHeight: "100vh",
        fontFamily: "sans-serif",
      }}
    >
      <h1 style={{ marginBottom: 24, fontSize: 24, fontWeight: "bold" }}>Extrator de Leads</h1>

      {/* Campos de Busca */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Nicho (ex: Clínica)"
          style={{
            flex: 1,
            padding: 12,
            background: "#111",
            border: "1px solid #333",
            color: "#fff",
            borderRadius: 8,
            outline: "none",
          }}
        />
        <input
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="Cidade"
          style={{
            flex: 1,
            padding: 12,
            background: "#111",
            border: "1px solid #333",
            color: "#fff",
            borderRadius: 8,
            outline: "none",
          }}
        />
        <button
          onClick={handleSearch}
          disabled={loading}
          style={{
            padding: "10px 24px",
            background: "#7c3aed",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: loading ? "not-allowed" : "pointer",
            fontWeight: 600,
            fontSize: 16,
          }}
        >
          {loading ? "Buscando..." : "Buscar"}
        </button>
      </div>

      {/* FILTROS DE BUSCA (API) */}
      <div style={{ display: "flex", gap: 16, marginTop: 12, marginBottom: 24, flexWrap: "wrap" }}>
        {/* Filtro Site */}
        <div>
          <label
            style={{ color: "#94a3b8", fontSize: 12, textTransform: "uppercase", fontWeight: 600 }}
          >
            SITE
          </label>
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            {["todos", "com", "sem"].map((f) => (
              <button
                key={f}
                onClick={() => setFiltroSite(f)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid",
                  borderColor: filtroSite === f ? "#7c3aed" : "#2a2a3a",
                  background: filtroSite === f ? "#7c3aed20" : "transparent",
                  color: filtroSite === f ? "#8b5cf6" : "#94a3b8",
                  cursor: "pointer",
                  fontSize: 13,
                  transition: "all 0.2s",
                }}
              >
                {f === "todos" ? "Todos" : f === "com" ? "Com Site" : "Sem Site"}
              </button>
            ))}
          </div>
        </div>

        {/* Filtro Contato */}
        <div>
          <label
            style={{ color: "#94a3b8", fontSize: 12, textTransform: "uppercase", fontWeight: 600 }}
          >
            CONTATO
          </label>
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            {["todos", "whatsapp"].map((f) => (
              <button
                key={f}
                onClick={() => setFiltroContato(f)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid",
                  borderColor: filtroContato === f ? "#7c3aed" : "#2a2a3a",
                  background: filtroContato === f ? "#7c3aed20" : "transparent",
                  color: filtroContato === f ? "#8b5cf6" : "#94a3b8",
                  cursor: "pointer",
                  fontSize: 13,
                  transition: "all 0.2s",
                }}
              >
                {f === "todos" ? "Todos os números" : "✓ Somente WhatsApp"}
              </button>
            ))}
          </div>
        </div>

        {/* Limite */}
        <div>
          <label
            style={{ color: "#94a3b8", fontSize: 12, textTransform: "uppercase", fontWeight: 600 }}
          >
            QUANTIDADE
          </label>
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            {[10, 20, 50, 100].map((n) => (
              <button
                key={n}
                onClick={() => setLimite(n)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid",
                  borderColor: limite === n ? "#7c3aed" : "#2a2a3a",
                  background: limite === n ? "#7c3aed20" : "transparent",
                  color: limite === n ? "#8b5cf6" : "#94a3b8",
                  cursor: "pointer",
                  fontSize: 13,
                  transition: "all 0.2s",
                }}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            color: "#ef4444",
            marginBottom: 16,
            padding: 12,
            background: "#ef444410",
            borderRadius: 8,
            border: "1px solid #ef444430",
          }}
        >
          {error}
        </div>
      )}

      {results.length > 0 && (
        <div style={{ background: "#111", borderRadius: 8, padding: 16, border: "1px solid #222" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 16,
            }}
          >
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <p style={{ color: "#94a3b8", margin: 0 }}>{results.length} resultados encontrados</p>
              <button
                onClick={async () => {
                  try {
                    const norm = (s: any) => String(s ?? "").replace(/\D/g, "");
                    let toMove = results.filter((r) => !r.isMoved);
                    if (toMove.length === 0) return toast.info("Nenhum lead novo para mover.");

                    setIsMovingMass(true);
                    const { data: userData } = await supabase.auth.getUser();
                    if (!userData.user) throw new Error("Usuário não autenticado");

                    // Filtrar duplicados: existentes no banco + repetidos dentro do próprio lote
                    const { data: existing } = await supabase
                      .from("leads")
                      .select("phone")
                      .eq("user_id", userData.user.id);
                    const existingSet = new Set(
                      (existing || []).map((l: any) => norm(l.phone)).filter(Boolean),
                    );
                    const seen = new Set<string>();
                    const skipped: any[] = [];
                    toMove = toMove.filter((l) => {
                      const p = norm(l.phone);
                      if (!p) {
                        skipped.push(l);
                        return false;
                      }
                      if (existingSet.has(p) || seen.has(p)) {
                        skipped.push(l);
                        return false;
                      }
                      seen.add(p);
                      return true;
                    });

                    if (toMove.length === 0) {
                      setIsMovingMass(false);
                      return toast.info(`Todos os ${skipped.length} leads já existem no CRM.`);
                    }
                    if (
                      !confirm(
                        `Importar ${toMove.length} leads para o CRM? Nenhuma mensagem será agendada.${skipped.length ? ` (${skipped.length} duplicados ignorados)` : ""}`,
                      )
                    ) {
                      setIsMovingMass(false);
                      return;
                    }

                    const { data: stage } = await supabase
                      .from("pipeline_stages")
                      .select("id")
                      .eq("name", "Prospecção")
                      .eq("user_id", userData.user.id)
                      .limit(1)
                      .maybeSingle();
                    const stageId = stage?.id;

                    // Inserir leads em lote sem iniciar uma automação.
                    const leadsToInsert = toMove.map((lead) => ({
                      user_id: userData.user.id,
                      name: lead.name,
                      phone: lead.phone,
                      whatsapp: lead.isLikelyWhatsapp ? lead.cleanPhone : null,
                      has_whatsapp: lead.isLikelyWhatsapp,
                      phone_valid: lead.hasValidPhone,
                      website: lead.website,
                      address: lead.address,
                      category: lead.category,
                      place_id: lead.place_id || null,
                      maps_url: lead.maps_url || null,
                      instagram_url: lead.instagram_url || null,
                      cover_photo_url: lead.cover_photo_url || null,
                      stage_id: stageId || null,
                      source: "extrator-google",
                      // Mesma regra do envio individual: sem consentimento
                      // aprovado o fluxo nao enfileira nada.
                      marketing_consent_status: "not_required",
                      marketing_consent_source: "extrator-google",
                    }));

                    const { data: insertedLeads, error: insertError } = await supabase
                      .from("leads")
                      .insert(leadsToInsert)
                      .select("id");

                    if (insertError) throw insertError;

                    if (insertedLeads?.length) {
                      const { error: touchpointError } = await supabase.from("touchpoints").insert(
                        insertedLeads.map((insertedLead) => ({
                          user_id: userData.user.id,
                          lead_id: insertedLead.id,
                          channel: "google_maps",
                          touch_type: "lead_imported",
                          metadata: {
                            source: "extrator-google",
                            query: String(query || "").trim() || null,
                            city: String(city || "").trim() || null,
                          },
                        })),
                      );
                      if (touchpointError) {
                        console.warn(
                          "[Extractor] touchpoints em lote nÃ£o registrados:",
                          touchpointError,
                        );
                        toast.warning(
                          "Leads importados, mas parte da atribuição não foi registrada.",
                        );
                      }
                    }

                    toast.success(
                      `${toMove.length} leads importados. Escolha uma campanha ou fluxo antes de enviar.${skipped.length ? ` ${skipped.length} duplicados ignorados.` : ""}`,
                    );
                    setResults((prev) => prev.map((r) => ({ ...r, isMoved: true })));
                  } catch (e: any) {
                    console.error("[Extractor] mover lote falhou:", e);
                    toast.error("Erro ao mover leads: " + (e?.message || "falha desconhecida"));
                  } finally {
                    setIsMovingMass(false);
                  }
                }}
                disabled={isMovingMass}
                style={{
                  padding: "8px 16px",
                  background: "#10b981",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  cursor: isMovingMass ? "not-allowed" : "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                  boxShadow: "0 4px 12px rgba(16, 185, 129, 0.2)",
                }}
              >
                {isMovingMass
                  ? "Importando..."
                  : `Importar ${results.filter((r) => !r.isMoved).length} novos para o CRM`}
              </button>
            </div>

            {/* Filtros de Exibição (Client-side) */}
            <div style={{ display: "flex", gap: 8 }}>
              {[
                { id: "all", label: `Todos (${results.length})` },
                {
                  id: "whatsapp",
                  label: `✓ WhatsApp (${results.filter((r) => r.isLikelyWhatsapp === true).length})`,
                },
                { id: "new", label: `Novos (${results.filter((r) => !r.isMoved).length})` },
              ].map((f) => (
                <button
                  key={f.id}
                  onClick={() => setViewFilter(f.id)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 4,
                    fontSize: 12,
                    border: "1px solid",
                    borderColor: viewFilter === f.id ? "#7c3aed" : "#333",
                    background: viewFilter === f.id ? "#7c3aed" : "transparent",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {filtered.map((r, i) => (
              <div
                key={r.id || i}
                style={{
                  padding: 12,
                  borderBottom: "1px solid #222",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div style={{ flex: 1 }}>
                  <strong style={{ display: "block", fontSize: 16 }}>{safeText(r?.name)}</strong>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                    <span style={{ color: "#94a3b8", fontSize: 14 }}>
                      {safeText(r?.phone || "Sem telefone")}
                    </span>

                    {/* Badges de validação */}
                    {r.isLikelyWhatsapp === true ? (
                      <span
                        style={{
                          fontSize: 10,
                          background: "#10b98120",
                          color: "#10b981",
                          padding: "2px 6px",
                          borderRadius: 4,
                          border: "1px solid #10b98130",
                          fontWeight: 600,
                        }}
                      >
                        WhatsApp provável
                      </span>
                    ) : r.hasValidPhone === true ? (
                      <span
                        style={{
                          fontSize: 10,
                          background: "#64748b20",
                          color: "#94a3b8",
                          padding: "2px 6px",
                          borderRadius: 4,
                          border: "1px solid #64748b30",
                          fontWeight: 600,
                        }}
                      >
                        Telefone válido
                      </span>
                    ) : (
                      <span
                        style={{
                          fontSize: 10,
                          background: "#ef444410",
                          color: "#ef4444",
                          padding: "2px 6px",
                          borderRadius: 4,
                          border: "1px solid #ef444430",
                          fontWeight: 600,
                        }}
                      >
                        Sem telefone válido
                      </span>
                    )}
                  </div>
                  <div style={{ color: "#64748b", fontSize: 12, marginTop: 2 }}>
                    {safeText(r?.address)}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {r.isLikelyWhatsapp && r.cleanPhone && (
                    <button
                      onClick={() => {
                        try {
                          const phone = String(r.cleanPhone).replace(/\D/g, "");
                          if (!phone) return;
                          window.open(
                            `https://wa.me/${encodeURIComponent(phone)}`,
                            "_blank",
                            "noopener,noreferrer",
                          );
                        } catch (err) {
                          console.error("[Extractor] abrir WhatsApp falhou:", err);
                        }
                      }}
                      style={{
                        padding: "6px 12px",
                        background: "#10b981",
                        color: "#fff",
                        border: "none",
                        borderRadius: 6,
                        cursor: "pointer",
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      Abrir WhatsApp
                    </button>
                  )}

                  {!r.isMoved && (
                    <button
                      onClick={() => handleMoveToLeads(r)}
                      style={{
                        padding: "6px 12px",
                        background: "#7c3aed",
                        color: "#fff",
                        border: "none",
                        borderRadius: 6,
                        cursor: "pointer",
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      Importar no CRM
                    </button>
                  )}

                  {r.isMoved && (
                    <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600 }}>
                      ✓ Movido
                    </span>
                  )}

                  <div
                    style={{
                      fontSize: 12,
                      color: r?.website ? "#10b981" : "#64748b",
                      background: r?.website ? "#10b98110" : "#64748b10",
                      padding: "4px 8px",
                      borderRadius: 4,
                      border: "1px solid",
                      borderColor: r?.website ? "#10b98130" : "#64748b30",
                    }}
                  >
                    {r?.website ? "✓ Site" : "✗ Sem site"}
                  </div>
                </div>
              </div>
            ))}
            {filtered.length === 0 && (
              <div style={{ textAlign: "center", padding: 32, color: "#64748b" }}>
                Nenhum resultado com este filtro.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
