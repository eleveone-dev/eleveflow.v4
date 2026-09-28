import React, { Component, ErrorInfo, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center min-h-[400px] p-6 text-center space-y-4 bg-[#1a1a1a] rounded-lg border border-[#2a2a2a] text-[#f1f5f9]">
          <div className="p-3 rounded-full bg-destructive/10 text-destructive">
            <AlertCircle className="h-10 w-10" />
          </div>
          <h2 className="text-xl font-bold">Esta página não carregou</h2>
          <p className="text-[#64748b] max-w-md">
            Ocorreu um erro inesperado ao carregar este componente. Por favor, tente recarregar a
            página.
          </p>
          <div className="flex gap-2">
            <Button
              onClick={() => window.location.reload()}
              className="bg-[#6366f1] hover:bg-[#6366f1]/90"
            >
              Recarregar página
            </Button>
            <Button
              variant="outline"
              onClick={() => this.setState({ hasError: false, error: null })}
              className="border-[#2a2a2a]"
            >
              Tentar novamente
            </Button>
          </div>
          {process.env.NODE_ENV === "development" && (
            <pre className="mt-4 p-4 bg-black/50 rounded text-left text-xs overflow-auto max-w-full">
              {this.state.error?.message}
            </pre>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
