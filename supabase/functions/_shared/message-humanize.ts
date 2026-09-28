// Deixa a mensagem com cara de gente, não de disparo em série.
//
// Portado do app antigo (eleve.flow.3), onde isso rodava em produção:
//   - spintax: `{Oi|Olá|Opa}` sorteia uma opção por envio, então duas pessoas
//     não recebem o mesmo texto byte a byte — o padrão que o WhatsApp usa para
//     marcar disparo em massa;
//   - saudação pelo relógio de Brasília (`{{saudacao}}`, `{{Saudacao}}`);
//   - primeiro nome (`{{primeiro_nome}}`), porque ninguém escreve o nome completo
//     de quem está chamando no WhatsApp.
//
// Deno-free e puro: o sorteio e o relógio entram por parâmetro, e é isso que deixa
// testar sem aleatoriedade.

const FUSO = "America/Sao_Paulo";

/**
 * Sorteia uma opção de cada grupo `{a|b|c}`, de dentro para fora, para aceitar
 * aninhamento. Chave sem `|` não é spintax e fica intacta: texto do cliente pode
 * ter chave literal.
 */
export function aplicarSpintax(texto: string, sortear: () => number = Math.random): string {
  if (!texto) return texto;
  const grupo = /\{([^{}]*\|[^{}]*)\}/;
  let saida = texto;
  // Limite de passadas: garante término mesmo com texto malformado.
  for (let passada = 0; passada < 50 && grupo.test(saida); passada++) {
    saida = saida.replace(grupo, (_m, interno: string) => {
      const opcoes = interno.split("|");
      const indice = Math.min(opcoes.length - 1, Math.floor(sortear() * opcoes.length));
      return opcoes[indice];
    });
  }
  return saida;
}

function horaEmBrasilia(agora: Date): number {
  const hora = new Intl.DateTimeFormat("en-US", {
    timeZone: FUSO,
    hour: "numeric",
    hourCycle: "h23",
  }).format(agora);
  return Number(hora);
}

export function saudacao(agora: Date = new Date()): "bom dia" | "boa tarde" | "boa noite" {
  const hora = horaEmBrasilia(agora);
  if (hora < 12) return "bom dia";
  if (hora < 18) return "boa tarde";
  return "boa noite";
}

export function primeiroNome(nome: unknown): string {
  return (
    String(nome ?? "")
      .trim()
      .split(/\s+/)[0] ?? ""
  );
}

export interface LeadParaMensagem {
  name?: string | null;
  company?: string | null;
  phone?: string | null;
}

/**
 * Monta o texto final. As variáveis são trocadas ANTES do sorteio: o spintax
 * enxerga `{{nome}}` como chave dupla e, sem esta ordem, comeria o marcador.
 */
export function renderizarMensagem(
  modelo: string,
  lead: LeadParaMensagem,
  opts: { sortear?: () => number; agora?: Date } = {},
): string {
  const agora = opts.agora ?? new Date();
  const ola = saudacao(agora);
  const comVariaveis = String(modelo ?? "")
    .replace(/{{\s*primeiro_nome\s*}}/g, primeiroNome(lead.name))
    .replace(/{{\s*nome\s*}}/g, lead.name ?? "")
    .replace(/{{\s*empresa\s*}}/g, lead.company ?? "")
    .replace(/{{\s*telefone\s*}}/g, lead.phone ?? "")
    .replace(/{{\s*Saudacao\s*}}/g, ola.charAt(0).toUpperCase() + ola.slice(1))
    .replace(/{{\s*saudacao\s*}}/g, ola);
  return aplicarSpintax(comVariaveis, opts.sortear);
}
