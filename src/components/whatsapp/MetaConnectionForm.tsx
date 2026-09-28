import { useState } from "react";
import { Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  useSaveMetaConnection,
  useValidateMetaToken,
  type DiscoveredNumber,
} from "@/hooks/use-whatsapp-connection";

/**
 * Configuração em dois passos: o token é validado contra a Meta antes de
 * qualquer gravação, e o número é escolhido entre os que ela devolveu. Digitar
 * um número à mão não é possível de propósito — foi assim que um Phone Number
 * ID inventado acabou gravado como se fosse real.
 */
export function MetaConnectionForm({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [accessToken, setAccessToken] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const validate = useValidateMetaToken();
  const save = useSaveMetaConnection();
  const numbers: DiscoveredNumber[] = validate.data?.numbers ?? [];

  const reset = () => {
    setAccessToken("");
    setWabaId("");
    setSelected(null);
    validate.reset();
    save.reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Conectar número da Meta</DialogTitle>
          <DialogDescription>
            O token é enviado ao servidor, validado na Graph API e guardado criptografado. Ele nunca
            fica salvo no navegador.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="meta-token">Access token</Label>
            <Input
              id="meta-token"
              type="password"
              autoComplete="off"
              placeholder="EAAJ..."
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="meta-waba">
              WABA ID <span className="font-normal text-muted-foreground">— opcional</span>
            </Label>
            <Input
              id="meta-waba"
              placeholder="Descoberto pelo token quando em branco"
              value={wabaId}
              onChange={(event) => setWabaId(event.target.value)}
            />
          </div>

          {validate.isError && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {validate.error.message}
            </p>
          )}

          {validate.isSuccess && (
            <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4">
              <p className="flex items-center gap-2 text-sm">
                <ShieldCheck className="h-4 w-4 text-[#34d399]" aria-hidden />
                Token válido · WABA{" "}
                <span className="font-mono text-xs">{validate.data.wabaId}</span>
              </p>

              {numbers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Esta WABA não tem nenhum número registrado. Registre um no painel da Meta antes de
                  conectar.
                </p>
              ) : (
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm font-medium">
                    Escolha o número devolvido pela Meta
                  </legend>
                  {numbers.map((number) => (
                    <label
                      key={number.phoneNumberId}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
                        selected === number.phoneNumberId
                          ? "border-[#7c3aed] bg-[#7c3aed]/10"
                          : "border-border hover:border-muted-foreground/40",
                      )}
                    >
                      <input
                        type="radio"
                        name="phone-number"
                        className="mt-1"
                        checked={selected === number.phoneNumberId}
                        onChange={() => setSelected(number.phoneNumberId)}
                      />
                      <span className="min-w-0 space-y-0.5">
                        <span className="block text-sm">
                          {number.displayPhoneNumber ?? "sem número visível"}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {number.verifiedName ?? "sem nome verificado"}
                          {number.qualityRating ? ` · ${number.qualityRating}` : ""}
                        </span>
                        <span className="block font-mono text-xs text-muted-foreground">
                          {number.phoneNumberId}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
            </div>
          )}

          {save.isError && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {save.error.message}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            {!validate.isSuccess ? (
              <Button
                onClick={() => validate.mutate({ accessToken, wabaId: wabaId.trim() || undefined })}
                disabled={!accessToken.trim() || validate.isPending}
              >
                {validate.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                )}
                Validar na Meta
              </Button>
            ) : (
              <Button
                onClick={() =>
                  save.mutate(
                    {
                      accessToken,
                      phoneNumberId: selected!,
                      wabaId: validate.data.wabaId,
                    },
                    {
                      onSuccess: () => {
                        reset();
                        onOpenChange(false);
                      },
                    },
                  )
                }
                disabled={!selected || save.isPending}
              >
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                Salvar conexão
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
