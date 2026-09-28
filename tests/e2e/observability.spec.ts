import { test, expect } from "@playwright/test";

// A senha vem do ambiente: fixa no codigo, ela envelhece na primeira rotacao e o
// teste passa a falhar por credencial, nao por defeito do app. Foi o que
// aconteceu — o teste tinha `e2e-password-123`.
const E2E_EMAIL = "e2e@eleveflow.test";
const E2E_PASSWORD = process.env.E2E_PASSWORD;

if (!E2E_PASSWORD) {
  throw new Error("E2E_PASSWORD must be configured for E2E tests");
}

test("página de observabilidade mostra gasto agregado e conversas do agente", async ({ page }) => {
  // networkidle + botão habilitado: mesmo padrão do login.spec — clique
  // pré-hidratação faz submit nativo e a navegação SPA nunca acontece.
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Senha").fill(E2E_PASSWORD!);
  const entrar = page.getByRole("button", { name: "Entrar" });
  await expect(entrar).toBeEnabled({ timeout: 30_000 });
  await entrar.click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30_000 });

  await page.goto("/observabilidade");

  // gasto 30d > $0 (as jornadas do agent-journey rodaram antes — mode serial do runner)
  const cost = page.getByTestId("cost-30d");
  await expect(cost).toBeVisible({ timeout: 15_000 });
  await expect(cost).not.toHaveText(/\$0\.0000/);

  // feed do agente tem sessão; transcript abre com mensagens
  const session = page.getByTestId("agent-session").first();
  await expect(session).toBeVisible();
  await session.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
