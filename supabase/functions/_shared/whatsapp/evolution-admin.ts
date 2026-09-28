// Ciclo de vida da instancia na Evolution: estado, pareamento por QR, registro
// de webhook, logout e remocao.
//
// Separado do provedor de propósito. O provedor entrega mensagem; isto aqui
// administra a conexao, e so a tela /whatsapp o consome.
//
// Deno-free: o Vitest importa este arquivo em Node.

import { evolutionWebhookPayloads } from "./evolution-webhook.ts";

export interface EvolutionAdminConfig {
  apiUrl: string;
  apiKey: string;
  instance: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

interface Chamada {
  ok: boolean;
  status: number;
  data: Record<string, any>;
}

function preparar(cfg: EvolutionAdminConfig) {
  const apiUrl = cfg.apiUrl.replace(/\/+$/, "");
  const instance = encodeURIComponent(cfg.instance);
  const fetchFn = cfg.fetchFn ?? fetch;
  const timeoutMs = Math.max(1_000, cfg.timeoutMs ?? 25_000);

  async function call(path: string, method = "GET", body?: unknown): Promise<Chamada> {
    const res = await fetchFn(`${apiUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", apikey: cfg.apiKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let data: Record<string, any>;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
    return { ok: res.ok, status: res.status, data };
  }

  return { apiUrl, instance, call };
}

export interface InstanceStatus {
  exists: boolean;
  connected: boolean;
  state: string | null;
}

export async function instanceStatus(cfg: EvolutionAdminConfig): Promise<InstanceStatus> {
  const { instance, call } = preparar(cfg);
  const r = await call(`/instance/connectionState/${instance}`);
  // 404 nao e falha: e instancia que ainda nao existe, que e o estado normal
  // antes do primeiro pareamento.
  if (r.status === 404) return { exists: false, connected: false, state: null };
  const state = r.data?.instance?.state ?? r.data?.state ?? null;
  return { exists: true, connected: state === "open", state };
}

export interface WebhookResult {
  ok: boolean;
  shape?: string;
  reason?: string;
  status?: number;
  data?: unknown;
}

export interface SetWebhookParams extends EvolutionAdminConfig {
  webhookUrl: string;
  webhookSecret: string;
}

/**
 * Registra o webhook com o header privado. Tenta os formatos de corpo em ordem
 * porque a Evolution mudou o schema entre releases e a instalacao self-hosted
 * pode estar em qualquer uma delas.
 */
export async function setInstanceWebhook(params: SetWebhookParams): Promise<WebhookResult> {
  // Registrar sem segredo criaria um webhook que o nosso lado nao consegue
  // distinguir de uma chamada forjada. Melhor nao registrar e dizer por que.
  if (!params.webhookSecret) return { ok: false, reason: "no_secret_configured" };

  const { instance, call } = preparar(params);
  const headers = { "x-eleveflow-webhook-secret": params.webhookSecret };
  let ultima: Chamada | null = null;

  for (const tentativa of evolutionWebhookPayloads(params.webhookUrl, headers)) {
    const r = await call(`/webhook/set/${instance}`, "POST", tentativa.body);
    if (r.ok) return { ok: true, shape: tentativa.shape, status: r.status, data: r.data };
    ultima = r;
  }

  return { ok: false, reason: "all_shapes_rejected", status: ultima?.status, data: ultima?.data };
}

export interface ConnectResult {
  connected: boolean;
  qrcode: string | null;
  created: boolean;
  webhook: WebhookResult;
  state: string | null;
}

export interface ConnectParams extends EvolutionAdminConfig {
  webhookUrl: string;
  webhookSecret: string;
}

/**
 * Leva a instancia ao estado pareavel: cria se nao existir, garante o webhook e
 * devolve o QR quando ainda nao esta conectada.
 */
export async function connectInstance(params: ConnectParams): Promise<ConnectResult> {
  const { instance, call } = preparar(params);
  const status = await instanceStatus(params);

  let created = false;
  if (!status.exists) {
    await call("/instance/create", "POST", {
      instanceName: params.instance,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
    });
    created = true;
  }

  // O webhook e registrado sempre, inclusive em instancia ja conectada: e o
  // unico jeito de corrigir um registro perdido sem desconectar o cliente.
  const webhook = await setInstanceWebhook(params);

  if (status.connected) {
    return { connected: true, qrcode: null, created, webhook, state: status.state };
  }

  const r = await call(`/instance/connect/${instance}`);
  const qrcode = r.data?.base64 ?? r.data?.qrcode?.base64 ?? r.data?.code ?? null;
  return { connected: false, qrcode, created, webhook, state: status.state };
}

export async function logoutInstance(cfg: EvolutionAdminConfig): Promise<Chamada> {
  const { instance, call } = preparar(cfg);
  return call(`/instance/logout/${instance}`, "DELETE");
}

export async function deleteInstance(cfg: EvolutionAdminConfig): Promise<Chamada> {
  const { instance, call } = preparar(cfg);
  return call(`/instance/delete/${instance}`, "DELETE");
}
