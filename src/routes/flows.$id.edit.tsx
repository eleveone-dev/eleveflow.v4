import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import AppLayout from "@/components/layout/AppLayout";
import FlowEditor from "@/pages/FlowEditor";
import FlowSimpleEditor from "@/pages/FlowSimpleEditor";
import FlowSequenceEditor from "@/pages/FlowSequenceEditor";

const searchSchema = z.object({
  mode: z.enum(["sequence", "simple", "advanced"]).optional(),
});

export const Route = createFileRoute("/flows/$id/edit")({
  validateSearch: searchSchema,
  component: FlowEditorPage,
});

function FlowEditorPage() {
  const { mode } = Route.useSearch();
  return (
    <AppLayout>
      {mode === "advanced" ? (
        <FlowEditor />
      ) : mode === "simple" ? (
        <FlowSimpleEditor />
      ) : (
        <FlowSequenceEditor />
      )}
    </AppLayout>
  );
}
