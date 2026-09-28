// Decide sobre qual instancia da Evolution o proxy pode agir.
//
// A regra que nao pode ser afrouxada: o nome da instancia NUNCA vem do corpo da
// requisicao. Vem do usuario autenticado. No export do Lovable esse campo era
// aceito do cliente e repassado a Evolution com a apikey mestre, o que deixava
// qualquer chamador ler o QR de outra conta, desconectar o WhatsApp dela ou
// enviar em nome dela.
//
// Admin alcanca outra conta por um campo proprio e explicito, checado contra
// user_roles pelo chamador.
//
// Deno-free: o Vitest importa este arquivo em Node.

export class ProxyAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProxyAuthError";
  }
}

export interface ProxyInstanceParams {
  client: { from: (table: string) => any };
  authUserId: string | null;
  isAdmin: boolean;
  targetUserId?: unknown;
}

export async function resolveProxyInstance(params: ProxyInstanceParams): Promise<string> {
  const { client, authUserId, isAdmin, targetUserId } = params;

  if (!authUserId) {
    throw new ProxyAuthError(401, "Authentication required");
  }

  let ownerId = authUserId;
  if (typeof targetUserId === "string" && targetUserId.trim() !== "") {
    const requested = targetUserId.trim();
    if (requested !== authUserId && !isAdmin) {
      throw new ProxyAuthError(403, "Not allowed to act on another account");
    }
    ownerId = requested;
  }

  const { data, error } = await client
    .from("whatsapp_connections")
    .select("instance_name")
    .eq("tenant_id", ownerId)
    .eq("provider", "evolution")
    .maybeSingle();

  if (error) throw new Error(error.message);

  // Sem linha ainda e o caso normal do primeiro pareamento: ela so nasce depois
  // que o QR e lido. A convencao do sistema e instance_name = user_id, e o dump
  // do projeto legado confirma que nunca houve outro nome gravado.
  return data?.instance_name ?? ownerId;
}
