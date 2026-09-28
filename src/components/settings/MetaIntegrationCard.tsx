import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useIsSuperadmin } from "@/hooks/useIsSuperadmin";
import { usePublicMetaConfig, type PublicMetaConfig } from "@/hooks/use-meta-public-config";

/**
 * Configuração de plataforma, não de tenant: App ID e Configuration ID valem
 * para todas as empresas. Por isso o cartão é restrito a superadmin e vive em
 * Configurações › Integrações, junto das outras chaves globais.
 *
 * Segredos (App Secret, access token, verify token) não aparecem aqui de
 * propósito — não são editáveis pela interface em nenhuma circunstância.
 */
export function MetaIntegrationCard() {
  const isSuperadmin = useIsSuperadmin();
  const queryClient = useQueryClient();
  const { data: config, isLoading } = usePublicMetaConfig();

  const [appId, setAppId] = useState("");
  const [configId, setConfigId] = useState("");
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!config) return;
    setAppId(config.appId ?? "");
    setConfigId(config.configId ?? "");
    setEnabled(config.enabled);
  }, [config]);

  const save = useMutation<PublicMetaConfig, Error, void>({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("meta-whatsapp-admin", {
        body: { action: "save-embedded-signup-config", appId, configId, enabled },
      });
      if (error) throw new Error(error.message);
      if (data?.success === false) throw new Error(data.error ?? "Falha ao salvar");
      return data.config as PublicMetaConfig;
    },
    onSuccess: () => {
      toast.success("Configuração da Meta salva");
      void queryClient.invalidateQueries({ queryKey: ["meta-public-config"] });
    },
    onError: (error) => toast.error(error.message),
  });

  if (!isSuperadmin) return null;

  return (
    <Card className="overflow-hidden rounded-2xl border-[#2a2a3a] bg-[#111118] text-white shadow-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Meta · Embedded Signup
          <span className="rounded border border-[#7c3aed]/40 bg-[#7c3aed]/10 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-[#a78bfa]">
            superadmin
          </span>
        </CardTitle>
        <CardDescription className="text-[#64748b]">
          Identificadores públicos do app da Meta, usados para iniciar o fluxo oficial de conexão.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {isLoading ? (
          <p className="text-sm text-[#64748b]">Carregando configuração…</p>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="meta-app-id">Meta App ID</Label>
              <Input
                id="meta-app-id"
                inputMode="numeric"
                placeholder="somente dígitos"
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
                className="border-[#2a2a2a] bg-[#0f0f0f] font-mono"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="meta-config-id">Embedded Signup Configuration ID</Label>
              <Input
                id="meta-config-id"
                inputMode="numeric"
                placeholder="somente dígitos"
                value={configId}
                onChange={(event) => setConfigId(event.target.value)}
                className="border-[#2a2a2a] bg-[#0f0f0f] font-mono"
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-[#2a2a3a] p-4">
              <div className="min-w-0">
                <Label htmlFor="meta-es-enabled" className="cursor-pointer">
                  Embedded Signup habilitado
                </Label>
                <p className="mt-1 text-xs text-[#64748b]">
                  Exige App ID e Configuration ID preenchidos.
                </p>
              </div>
              <Switch id="meta-es-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <p className="flex items-start gap-2 text-xs text-[#64748b]">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              App Secret, access token e verify token não são editáveis aqui: ficam apenas nos
              secrets do servidor.
            </p>

            {save.isError && (
              <p className="flex items-start gap-2 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {save.error.message}
              </p>
            )}
          </>
        )}
      </CardContent>

      <CardFooter>
        <Button
          onClick={() => save.mutate()}
          disabled={save.isPending || isLoading}
          className="h-11 bg-[#7c3aed] px-8 font-bold hover:bg-[#6d28d9]"
        >
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          Salvar configuração da Meta
        </Button>
      </CardFooter>
    </Card>
  );
}
