// Traduz o estado da conexão Evolution nos elos que a tela desenha.
//
// Separado do hook de propósito: aqui não há rede nem React, só a regra de
// quando a tela pode afirmar cada coisa — e de onde veio a afirmação. Testável
// em Node, como `meta-embedded-signup.ts`.
//
// Regra que a tela já quebrou uma vez: `missing` é ausência de evidência,
// `failed` é evidência de falha. Antes do primeiro pareamento nada falhou.
// E quando o servidor da Evolution não responde, nenhum elo tem o direito de
// afirmar estado: vira `unknown`.

// O contrato do elo é da tela, não deste módulo: a cadeia é a mesma para
// qualquer provedor.
import type { ChainLink } from "@/components/whatsapp/ConnectionChain";

/** `exists` e `connected` vêm do servidor da Evolution, consultado agora.
 *  `configured` e `webhookAt` vêm do nosso banco. A distinção importa: o que o
 *  banco guarda é registro do que aconteceu, não prova do que está acontecendo. */
export interface EvolutionState {
  configured: boolean;
  instance: string | null;
  exists: boolean;
  connected: boolean;
  providerState: string | null;
  webhookAt: string | null;
  checkedAt: string;
  error?: { message: string } | null;
}

const emPtBr = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR") : null);

export function evolutionLinks(state: EvolutionState): ChainLink[] {
  const agora = new Date(state.checkedAt).toLocaleString("pt-BR");
  const semResposta = !!state.error;

  return [
    {
      id: "instance",
      label: state.exists ? "Instância criada" : "Instância ainda não criada",
      state: semResposta ? "unknown" : state.exists ? "ok" : "missing",
      provenance: semResposta
        ? `o servidor da Evolution não respondeu: ${state.error!.message}`
        : state.exists
          ? `${state.instance ?? "a instância"} existe no servidor — conferido em ${agora}`
          : "nenhuma instância com este nome no servidor",
    },
    {
      id: "paired",
      label: state.connected ? "Aparelho pareado" : "Aparelho ainda não pareado",
      state: semResposta
        ? "unknown"
        : state.connected
          ? "ok"
          : state.exists
            ? "missing"
            : "unknown",
      provenance: semResposta
        ? "depende do servidor da Evolution"
        : state.connected
          ? `a Evolution respondeu estado "${state.providerState}" — conferido em ${agora}`
          : state.exists
            ? `estado atual: ${state.providerState ?? "desconhecido"}. Leia o código com o celular para parear.`
            : "depende da instância",
    },
    {
      id: "webhook",
      label: state.webhookAt ? "Webhook registrado" : "Webhook não registrado",
      state: state.webhookAt ? "ok" : "missing",
      provenance: state.webhookAt
        ? `registrado com o cabeçalho privado em ${emPtBr(state.webhookAt)}`
        : "nenhum registro confirmado; sem ele nada chega ao CRM",
    },
  ];
}

export function evolutionHeadline(state: EvolutionState): { line: string; tone: string } {
  if (state.error) {
    return { line: "Servidor da Evolution não respondeu", tone: "text-[#f87171]" };
  }
  if (!state.exists) {
    return { line: "Nenhum número conectado", tone: "text-muted-foreground" };
  }
  if (!state.connected) {
    return { line: "Instância criada, aparelho não pareado", tone: "text-[#fbbf24]" };
  }
  if (!state.webhookAt) {
    return { line: "Pareado, mas sem webhook registrado", tone: "text-[#fbbf24]" };
  }
  return { line: "Número pareado e em uso", tone: "text-[#34d399]" };
}
