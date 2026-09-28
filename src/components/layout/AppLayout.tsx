import { useEffect, useState, memo, lazy, Suspense } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate, Outlet, useLocation } from "@tanstack/react-router";
import {
  Home,
  Users,
  Kanban,
  GitBranch,
  MessageCircle,
  MessagesSquare,
  FileText,
  ScrollText,
  Settings,
  LogOut,
  Send,
  Crosshair,
  X,
  Smartphone,
  Loader2,
  Activity,
  CheckSquare,
  Gauge,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/hooks/use-crm";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

const FlowEditor = lazy(() => import("@/pages/FlowEditor"));

import { useIsSuperadmin } from "@/hooks/useIsSuperadmin";

const navItems: Array<{ icon: any; label: string; to: string; adminOnly?: boolean }> = [
  { icon: Home, label: "Dashboard", to: "/dashboard" },
  { icon: Users, label: "Leads", to: "/leads" },
  { icon: Crosshair, label: "Extrator", to: "/extractor" },
  { icon: Kanban, label: "Pipeline", to: "/pipeline" },
  { icon: GitBranch, label: "Fluxos", to: "/flows" },
  { icon: Send, label: "Fila de Envio", to: "/queue" },
  { icon: MessagesSquare, label: "Conversas", to: "/conversas" },
  { icon: FileText, label: "Modelos", to: "/modelos" },
  { icon: MessageCircle, label: "WhatsApp", to: "/whatsapp" },
  { icon: ScrollText, label: "Logs", to: "/logs" },
  // Painel de administracao da plataforma: custo de IA e saude dos envios de
  // todas as contas. Nao e ferramenta de cliente.
  { icon: Gauge, label: "Observabilidade", to: "/observabilidade", adminOnly: true },
  { icon: CheckSquare, label: "Minhas Tarefas", to: "/tasks" },

  { icon: Settings, label: "Configurações", to: "/settings" },
  { icon: Activity, label: "Diagnóstico", to: "/diagnostics" },
];

export default function Layout({ children }: { children?: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState<any>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { data: account } = useAccount();
  const isSuperadmin = useIsSuperadmin();
  const visibleNavItems = navItems.filter((item) => !item.adminOnly || isSuperadmin);

  const { data: queueCount } = useQuery({
    queryKey: ["pending-queue-count"],
    queryFn: async () => {
      const { count } = await supabase
        .from("send_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending");
      return count || 0;
    },
    refetchInterval: 10000,
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        navigate({ to: "/login" });
      } else {
        setUser(session.user);
      }
    });

    if (account && !account.onboarding_completed && location.pathname !== "/onboarding") {
      navigate({ to: "/onboarding" });
    }

    const handleKeydown = (e: KeyboardEvent) => {
      if (["input", "textarea"].includes((e.target as HTMLElement).tagName.toLowerCase())) return;

      if (e.key.toLowerCase() === "n") {
        navigate({ to: "/leads" as any });
      }
      if (e.key.toLowerCase() === "f") {
        navigate({ to: "/flows" as any });
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/login" });
  };

  if (!user) return null;

  const SidebarContent = memo(
    ({ queueCount, account, userEmail, handleLogout, currentPath }: any) => (
      <div className="flex flex-col h-full bg-[#0d0d14]">
        <div className="p-4 lg:p-8 flex justify-center lg:justify-start">
          <h1 className="text-xl font-bold flex items-center gap-2 tracking-tight">
            <span className="text-2xl">⚡</span>
            <span className="hidden lg:inline bg-linear-to-r from-[#7c3aed] to-[#3b82f6] bg-clip-text text-transparent">
              EleveFlow
            </span>
          </h1>
        </div>
        <nav className="flex-1 px-2 lg:px-4 space-y-1.5">
          {visibleNavItems.map((item) => (
            <button
              key={item.label}
              onClick={() => {
                navigate({ to: item.to as any });
                setIsMobileMenuOpen(false);
              }}
              className={`flex items-center justify-center lg:justify-start w-full px-2 lg:px-4 py-2.5 text-sm font-medium rounded-lg transition-all group ${
                currentPath === item.to
                  ? "bg-[#7c3aed15] text-[#7c3aed] border-l-2 border-[#7c3aed]"
                  : "text-[#94a3b8] hover:bg-[#1a1a24] hover:text-white"
              }`}
              title={item.label}
            >
              <item.icon
                className={`h-5 w-5 transition-colors ${currentPath === item.to ? "text-[#7c3aed]" : "text-[#475569] group-hover:text-white"} ${item.label === "Dashboard" ? "" : "lg:mr-3"}`}
              />
              <span className="hidden lg:inline">{item.label}</span>
              {item.to === "/queue" && queueCount !== undefined && queueCount > 0 && (
                <Badge className="hidden lg:flex ml-auto bg-[#7c3aed] text-white border-none text-[10px] px-1.5 py-0">
                  {queueCount}
                </Badge>
              )}
            </button>
          ))}
        </nav>
        <div className="p-4 lg:p-6 border-t border-[#1e1e2e] bg-[#0d0d14]">
          <div className="flex items-center justify-center lg:justify-start gap-3 px-0 lg:px-2 mb-6">
            <div className="relative">
              <div className="h-10 w-10 rounded-full bg-linear-to-br from-[#7c3aed] to-[#6d28d9] flex items-center justify-center text-sm font-bold shadow-lg shadow-[#7c3aed]/20">
                {account?.name?.substring(0, 2).toUpperCase() || "EF"}
              </div>
              <div
                className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#0d0d14] ${account?.whatsapp_status === "connected" ? "bg-[#10b981]" : "bg-[#ef4444]"}`}
              />
            </div>
            <div className="hidden lg:block flex-1 overflow-hidden">
              <p className="text-sm font-semibold truncate text-[#f1f5f9]">
                {account?.name || "Usuário"}
              </p>
              <p className="text-xs text-[#475569] truncate">{userEmail}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="w-full justify-center lg:justify-start text-[#475569] hover:text-[#ef4444] group px-2 lg:px-4"
          >
            <LogOut className="h-4 w-4 lg:mr-2 group-hover:rotate-12 transition-transform" />
            <span className="hidden lg:inline">Sair</span>
          </Button>
        </div>
      </div>
    ),
  );

  return (
    <div className="flex h-screen bg-[#0a0a0f] text-[#f1f5f9]">
      {/* Sidebar - Always visible */}
      <aside className="flex w-[70px] lg:w-[240px] bg-[#0d0d14] border-r border-[#1e1e2e] flex-col transition-all duration-300 overflow-hidden group">
        <SidebarContent
          queueCount={queueCount}
          account={account}
          userEmail={user.email}
          handleLogout={handleLogout}
          currentPath={location.pathname}
        />
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {location.pathname.startsWith("/flows/") && location.pathname.endsWith("/edit") ? (
          <main className="flex-1 overflow-hidden">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center bg-[#0a0a0f]">
                  <Loader2 className="h-8 w-8 animate-spin text-[#7c3aed]" />
                </div>
              }
            >
              <FlowEditor />
            </Suspense>
          </main>
        ) : (
          <>
            <header className="h-16 bg-[#0a0a0f]/80 backdrop-blur-md border-b border-[#1e1e2e] flex items-center justify-between px-4 lg:px-8 sticky top-0 z-10">
              <div className="flex items-center gap-4">
                <h1 className="lg:hidden text-xl font-bold bg-linear-to-r from-[#7c3aed] to-[#3b82f6] bg-clip-text text-transparent">
                  EleveFlow
                </h1>
              </div>

              <div className="hidden lg:block text-[11px] font-bold uppercase tracking-[0.2em] text-[#475569]">
                {location.pathname === "/dashboard"
                  ? "Bem-vindo ao EleveFlow"
                  : "EleveFlow CRM ⚡ v2.0"}
              </div>

              <div className="flex items-center gap-3">
                {account?.whatsapp_status === "connected" ? (
                  <Badge
                    variant="success"
                    className="h-7 px-3 rounded-full font-bold text-[10px] hidden sm:flex shadow-lg shadow-green-500/10"
                  >
                    <Smartphone className="h-3 w-3 mr-1.5" /> WHATSAPP ON
                  </Badge>
                ) : (
                  <Badge
                    variant="destructive"
                    className="h-7 px-3 rounded-full font-bold text-[10px] hidden sm:flex shadow-lg shadow-red-500/10 animate-pulse cursor-pointer"
                    onClick={() => navigate({ to: "/whatsapp" as any })}
                  >
                    <X className="h-3 w-3 mr-1.5" /> WHATSAPP OFF
                  </Badge>
                )}
              </div>
            </header>
            <main className="flex-1 overflow-auto p-4 lg:p-8">{children || <Outlet />}</main>
          </>
        )}
      </div>
    </div>
  );
}
