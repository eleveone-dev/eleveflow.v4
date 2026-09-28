import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode, memo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Toaster } from "@/components/ui/sonner";
import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#0f0f0f] px-4 text-[#f1f5f9]">
      <div className="max-w-md text-center">
        <h1 className="text-9xl font-bold text-[#818cf8]">404</h1>
        <h2 className="mt-4 text-2xl font-semibold">Página não encontrada</h2>
        <p className="mt-2 text-[#cbd5e1]">
          A página que você está procurando não existe ou foi movida.
        </p>
        <div className="mt-8">
          <Link
            to="/dashboard"
            className="inline-flex items-center justify-center rounded-md bg-[#6366f1] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#6366f1]/90"
          >
            Voltar para o Início
          </Link>
        </div>
      </div>
    </main>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "EleveFlow CRM" },
      {
        name: "description",
        content: "CRM automático multi-contas com motor de fluxos personalizável",
      },
      { name: "author", content: "EleveFlow" },
      { property: "og:title", content: "EleveFlow CRM" },
      { property: "og:description", content: "Automação inteligente para seu negócio" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow, noarchive" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootShell,
  component: () => <RootComponent />,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

// Otimização: Memoizing the Root component to prevent unnecessary re-renders
const RootComponent = memo(function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function checkSession() {
      setLoading(true);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Session check timed out")), 5000),
      );

      try {
        const { data, error } = await Promise.race([
          supabase.auth.getSession(),
          timeoutPromise as any,
        ]);

        if (!mounted) return;

        if (error) {
          console.error("[Session Error]:", error);
        } else if (data) {
          setSession(data.session);
        }

        setLoading(false);

        const publicRoutes = ["/login", "/register", "/forgot-password", "/reset-password"];
        if (!data?.session && !publicRoutes.includes(location.pathname)) {
          navigate({ to: "/login" });
        }
      } catch (err) {
        console.error("[Unexpected Session Error]:", err);
        if (mounted) setLoading(false);
      }
    }

    checkSession();

    const failSafe = setTimeout(() => {
      if (mounted) setLoading(false);
    }, 3000);

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setSession(session);
      const publicRoutes = ["/login", "/register", "/forgot-password", "/reset-password"];
      if (!session && !publicRoutes.includes(location.pathname)) {
        navigate({ to: "/login" });
      }
    });

    return () => {
      mounted = false;
      clearTimeout(failSafe);
      subscription.unsubscribe();
    };
  }, [location.pathname, navigate]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0f0f0f] text-white">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#7c3aed] border-t-transparent"></div>
          <p className="text-sm font-medium">Carregando...</p>
        </div>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <Toaster position="top-right" />
    </QueryClientProvider>
  );
});
