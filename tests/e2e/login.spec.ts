import { test, expect } from "@playwright/test";

// A senha vem do ambiente: fixa no codigo, ela envelhece na primeira rotacao e o
// teste passa a falhar por credencial, nao por defeito do app. Foi o que
// aconteceu — o teste tinha `e2e-password-123`.
const E2E_EMAIL = "e2e@eleveflow.test";
const E2E_PASSWORD = process.env.E2E_PASSWORD;

if (!E2E_PASSWORD) {
  throw new Error("E2E_PASSWORD must be configured for E2E tests");
}

test("login com usuário e2e chega ao app autenticado", async ({ page }) => {
  // networkidle: hidratação no dev server depende de transforms on-demand
  // do Vite; sem isso o clique chega antes do React assumir o form.
  await page.goto("/login", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "EleveFlow" })).toBeVisible();

  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Senha").fill(E2E_PASSWORD!);
  // Botão fica desabilitado até a hidratação — esperar habilitar evita
  // submit nativo pré-React (que vazaria credenciais na URL).
  const entrar = page.getByRole("button", { name: "Entrar" });
  await expect(entrar).toBeEnabled({ timeout: 30_000 });
  await entrar.click();

  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30_000 });
  expect(page.url()).toMatch(/\/(dashboard|onboarding)/);
});
