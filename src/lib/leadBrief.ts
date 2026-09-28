// Utility: build a ChatGPT-ready text block from an enriched lead.
export function buildLeadBriefForChatGPT(lead: any): string {
  const phoneDigits = String(lead.whatsapp || lead.phone || "").replace(/\D/g, "");
  const waUrl = phoneDigits
    ? `https://wa.me/${phoneDigits.startsWith("55") ? phoneDigits : `55${phoneDigits}`}`
    : "";
  const mapsUrl =
    lead.maps_url ||
    (lead.place_id ? `https://www.google.com/maps/place/?q=place_id:${lead.place_id}` : "") ||
    (lead.address
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lead.address)}`
      : "");

  const reviews = Array.isArray(lead.top_reviews) ? lead.top_reviews : [];
  const reviewsText = reviews.length
    ? reviews
        .map(
          (r: any, i: number) =>
            `  ${i + 1}. ${r.author || "Cliente"} (${r.rating || 5}★): "${(r.text || "").trim()}"`,
        )
        .join("\n")
    : "  (sem avaliações coletadas)";

  return `=== DADOS PARA LANDING PAGE ===

NOME DO NEGÓCIO: ${lead.name || ""}
CATEGORIA: ${lead.category || ""}
ENDEREÇO: ${lead.address || ""}
TELEFONE: ${lead.phone || ""}
WHATSAPP: ${waUrl}
INSTAGRAM: ${lead.instagram_url || ""}
SITE: ${lead.website || ""}
GOOGLE MAPS / MEU NEGÓCIO: ${mapsUrl}

SOBRE:
${lead.about || "(não disponível)"}

IMAGENS (links permanentes - não expiram):
- Capa (Google Meu Negócio): ${lead.cover_photo_url || "(não disponível)"}
- Logo: ${lead.logo_url || "(não detectado)"}
- Profissional: ${lead.professional_photo_url || "(não detectado)"}
- Fachada: ${lead.facade_photo_url || "(não detectado)"}
- Estrutura: ${lead.structure_photo_url || "(não detectado)"}
- Foto perfil Instagram: ${lead.instagram_photo_url || "(não disponível)"}

TOP 3 AVALIAÇÕES POSITIVAS:
${reviewsText}

=== FIM DOS DADOS ===
Use os dados acima para criar uma landing page de alta conversão para esse negócio.`;
}
