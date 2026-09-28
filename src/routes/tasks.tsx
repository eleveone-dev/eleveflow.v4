import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import Tasks from "@/pages/Tasks";

export const Route = createFileRoute("/tasks")({
  head: () => ({
    meta: [
      { title: "Minhas Tarefas — EleveFlow CRM" },
      {
        name: "description",
        content: "Organize sua rotina pessoal com a página de tarefas do EleveFlow CRM.",
      },
      { property: "og:title", content: "Minhas Tarefas — EleveFlow CRM" },
      {
        property: "og:description",
        content: "Organize sua rotina pessoal com a página de tarefas do EleveFlow CRM.",
      },
    ],
  }),
  component: () => (
    <AppLayout>
      <Tasks />
    </AppLayout>
  ),
});
