import { cn } from "@/lib/utils";
import type { CheckState } from "@/hooks/use-whatsapp-connection";

/** Ausência de evidência (`untested`, `missing`) é desenhada como contorno vazio;
 *  evidência de falha, como marca cheia. Confundir os dois foi o bug de 30/07. */
const STATE_STYLE: Record<CheckState, { dot: string; rail: string; label: string }> = {
  ok: {
    dot: "bg-[#34d399] shadow-[0_0_0_4px_rgba(52,211,153,0.12)]",
    rail: "bg-[#34d399]/40",
    label: "text-foreground",
  },
  failed: {
    dot: "bg-[#f87171] shadow-[0_0_0_4px_rgba(248,113,113,0.12)]",
    rail: "bg-border",
    label: "text-foreground",
  },
  missing: {
    dot: "border border-dashed border-muted-foreground/60",
    rail: "bg-border",
    label: "text-muted-foreground",
  },
  untested: {
    dot: "border border-dashed border-muted-foreground/60",
    rail: "bg-border",
    label: "text-muted-foreground",
  },
  unknown: { dot: "border border-border", rail: "bg-border", label: "text-muted-foreground" },
};

const SR_STATE: Record<CheckState, string> = {
  ok: "confirmado",
  failed: "com falha",
  missing: "não configurado",
  untested: "ainda não testado",
  unknown: "não verificado",
};

export interface ChainLink {
  id: string;
  label: string;
  state: CheckState;
  /** De onde veio a afirmação. Sem isso a tela volta a poder mentir. */
  provenance: string;
}

/** A cadeia de pré-requisitos, igual para qualquer provedor. Cada elo carrega a
 *  procedência da afirmação, porque a tela já repetiu como verdade um valor que
 *  alguém tinha semeado à mão no banco. */
export function ConnectionChain({ links }: { links: ChainLink[] }) {
  return (
    <ol className="relative">
      {links.map((link, index) => {
        const style = STATE_STYLE[link.state];
        const last = index === links.length - 1;
        return (
          <li key={link.id} className="relative flex gap-4 pb-7 last:pb-0">
            {!last && (
              <span
                aria-hidden
                className={cn("absolute left-[5px] top-4 h-full w-px", style.rail)}
              />
            )}
            <span
              aria-hidden
              className={cn("relative mt-[5px] h-[11px] w-[11px] shrink-0 rounded-full", style.dot)}
            />
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm font-medium leading-tight", style.label)}>{link.label}</p>
              <p className="mt-1 text-sm text-muted-foreground">{link.provenance}</p>
            </div>
            <span className="sr-only">{SR_STATE[link.state]}</span>
          </li>
        );
      })}
    </ol>
  );
}
