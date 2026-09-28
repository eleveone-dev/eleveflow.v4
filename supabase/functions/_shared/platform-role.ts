// Papel de plataforma. Vive em app_metadata porque o cliente não consegue
// escrever nesse campo — user_metadata é editável pelo próprio usuário e não
// serve como autorização.

import { HttpError } from "./http-error.ts";

export const SUPERADMIN_ROLE = "superadmin";

export function isSuperadmin(user: unknown): boolean {
  const role = (user as { app_metadata?: { platform_role?: unknown } } | null)?.app_metadata
    ?.platform_role;
  return role === SUPERADMIN_ROLE;
}

export function assertSuperadmin(user: unknown): void {
  if (!isSuperadmin(user)) {
    throw new HttpError(403, "This operation is restricted to platform superadmins");
  }
}

export function generateWebhookVerifyToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
