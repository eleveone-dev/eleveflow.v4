// Logica pura da recuperacao do historico da Evolution. telefoneDoRegistro e
// chaveTelefone nao dependem de nada: o script os envia como texto para rodar
// dentro do container, onde filtram as conversas antes de sair do servidor.

import {
  classifyEvolutionContent,
  mediaTypeColumn,
} from "../../supabase/functions/_shared/whatsapp/evolution-parse.ts";

export interface ChaveEvolution {
  id?: string;
  fromMe?: boolean;
  remoteJid?: string;
  remoteJidAlt?: string;
}

export interface RegistroEvolution {
  key: ChaveEvolution;
  message?: Record<string, unknown> | null;
  messageTimestamp?: number | string;
  source?: string;
}

export interface LinhaMensagem {
  user_id: string;
  lead_id: string;
  direction: "inbound" | "outbound";
  content: string;
  media_type: string | null;
  origin: string | null;
  status: string | null;
  whatsapp_id: string;
  created_at: string;
}

export function chaveTelefone(digitos: string | null | undefined): string {
  const d = String(digitos ?? "").replace(/\D/g, "");
  // Celular BR aparece com e sem o nono digito: compara DDD + 8 finais.
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    return "55" + d.slice(2, 4) + d.slice(-8);
  }
  return d;
}

export function telefoneDoRegistro(key: { remoteJid?: string; remoteJidAlt?: string }): string {
  const jid = String(key.remoteJid ?? "");
  if (/@(g\.us|newsletter|broadcast)$/i.test(jid)) return "";
  if (!/@lid$/i.test(jid)) return jid.split("@")[0].replace(/\D/g, "");
  const alt = String(key.remoteJidAlt ?? "");
  return !alt || /@lid$/i.test(alt) ? "" : alt.split("@")[0].replace(/\D/g, "");
}

export function planejarImportacao(
  registros: RegistroEvolution[],
  leadPorChave: Map<string, string>,
  wamidsExistentes: Set<string>,
  userId: string,
): { inserir: LinhaMensagem[]; contagem: Record<string, number> } {
  const contagem: Record<string, number> = {
    duplicada: 0,
    sem_lead: 0,
    tipo_ignorado: 0,
    origem_ambigua: 0,
    sem_id: 0,
  };
  const vistos = new Set(wamidsExistentes);
  const inserir: LinhaMensagem[] = [];

  for (const r of registros) {
    const id = r.key?.id;
    if (!id) {
      contagem.sem_id++;
      continue;
    }
    if (vistos.has(id)) {
      contagem.duplicada++;
      continue;
    }
    const leadId = leadPorChave.get(chaveTelefone(telefoneDoRegistro(r.key)));
    if (!leadId) {
      contagem.sem_lead++;
      continue;
    }
    const conteudo = classifyEvolutionContent(r.message as Record<string, any> | null | undefined);
    if (!conteudo) {
      contagem.tipo_ignorado++;
      continue;
    }
    const doAparelho = r.source === "android" || r.source === "ios";
    // Enviada pela web ou de origem desconhecida pode ser envio automatico antigo
    // ou WhatsApp Web: origem inventada e pior que ausente.
    if (r.key.fromMe && !doAparelho) {
      contagem.origem_ambigua++;
      continue;
    }

    vistos.add(id);
    inserir.push({
      user_id: userId,
      lead_id: leadId,
      direction: r.key.fromMe ? "outbound" : "inbound",
      content: conteudo.text,
      media_type: mediaTypeColumn(conteudo.type),
      origin: r.key.fromMe ? "business_app" : null,
      status: r.key.fromMe ? null : "received",
      whatsapp_id: id,
      created_at: new Date(Number(r.messageTimestamp ?? 0) * 1000).toISOString(),
    });
  }
  return { inserir, contagem };
}
