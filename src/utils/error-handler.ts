import { toast } from "sonner";

/**
 * Interface padronizada para erros da aplicação
 */
export interface AppError extends Error {
  code?: string;
  details?: any;
  userMessage?: string;
}

/**
 * Trata erros de forma global, logando e exibindo toast para o usuário
 */
export const handleError = (error: unknown, context?: string) => {
  console.error(`[Error Context: ${context || "Global"}]`, error);

  let message = "Ocorreu um erro inesperado.";
  const description = "";

  if (error instanceof Error) {
    message = (error as AppError).userMessage || error.message;

    // Tratamentos específicos para Supabase / Auth
    if (error.message.includes("JWT expired")) {
      message = "Sua sessão expirou. Por favor, faça login novamente.";
    } else if (error.message.includes("Invalid login credentials")) {
      message = "Credenciais inválidas. Verifique seu e-mail e senha.";
    } else if (error.message.includes("Network Error")) {
      message = "Erro de conexão. Verifique sua internet.";
    }
  } else if (typeof error === "string") {
    message = error;
  }

  toast.error(message, {
    description: description || undefined,
  });

  return error;
};

/**
 * Wrapper para funções assíncronas com tratamento de erro integrado
 */
export async function withErrorHandling<T>(
  promise: Promise<T>,
  context: string,
  customUserMessage?: string,
): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (customUserMessage && error instanceof Error) {
      (error as AppError).userMessage = customUserMessage;
    }
    handleError(error, context);
    return null;
  }
}
