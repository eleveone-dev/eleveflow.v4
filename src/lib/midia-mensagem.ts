// Rótulo de mensagem de mídia. A mídia não é baixada nem transcrita: a tela diz o
// tipo e, no áudio, que ninguém transcreveu.

const ROTULOS: Record<string, string> = {
  audio: "Áudio · não transcrito",
  image: "Imagem",
  video: "Vídeo",
  document: "Documento",
  sticker: "Figurinha",
  location: "Localização",
  contact: "Contato",
  other: "Mídia",
};

export function rotuloMidia(mediaType: string | null | undefined): string | null {
  if (!mediaType) return null;
  return ROTULOS[mediaType] ?? ROTULOS.other;
}

/** Texto curto da última mensagem na lista de conversas. */
export function previaMensagem(content: string, mediaType: string | null | undefined): string {
  const rotulo = rotuloMidia(mediaType);
  if (!rotulo) return content;
  return content ? `${rotulo}: ${content}` : rotulo;
}
