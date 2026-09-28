import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Somente cosmético: decide se a UI administrativa aparece. A autoridade é o
 * servidor, que relê o claim do token em toda operação.
 */
/** `undefined` enquanto o papel não foi lido: quem guarda rota precisa saber a
 *  diferença entre "não é admin" e "ainda não sei", senão a tela pisca
 *  "restrito" para o próprio admin. Em contexto booleano, `undefined` é falso —
 *  então quem só esconde UI continua funcionando sem mudança. */
export function useIsSuperadmin(): boolean | undefined {
  const [isSuperadmin, setIsSuperadmin] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let active = true;

    const read = async () => {
      const { data } = await supabase.auth.getUser();
      const role = (data.user?.app_metadata as { platform_role?: string } | undefined)
        ?.platform_role;
      if (active) setIsSuperadmin(role === "superadmin");
    };

    void read();
    const { data: subscription } = supabase.auth.onAuthStateChange(() => {
      void read();
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  return isSuperadmin;
}
