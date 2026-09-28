import { supabase } from "@/integrations/supabase/client";
import { handleError } from "@/utils/error-handler";

export type QueueProcessResult = {
  processed: number;
  failed: number;
  skipped?: string;
};

type QueueProcessorResponse = {
  reason?: string;
  results?: Array<{ id?: string; status?: string }>;
  skipped?: Array<{ reason?: string }>;
};

export async function processQueueBatch(batchSize = 5): Promise<QueueProcessResult> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Usuário não autenticado");

    const { data: pendingItems, error: pendingError } = await supabase
      .from("send_queue")
      .select("id")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .lte("scheduled_at", new Date().toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(batchSize);

    if (pendingError) throw pendingError;
    if (!pendingItems?.length) return { processed: 0, failed: 0 };

    let processed = 0;
    let failed = 0;
    let skipped: string | undefined;

    for (const item of pendingItems) {
      const { data, error } = await supabase.functions.invoke<QueueProcessorResponse>(
        "process-queue",
        {
          body: { queueItemId: item.id },
        },
      );
      if (error) throw error;

      const result = data?.results?.find((entry) => entry.id === item.id) ?? data?.results?.[0];
      if (result?.status === "sent") {
        processed += 1;
        continue;
      }

      const { data: queueItem, error: queueItemError } = await supabase
        .from("send_queue")
        .select("status")
        .eq("id", item.id)
        .maybeSingle();
      if (queueItemError) throw queueItemError;

      if (queueItem?.status === "failed") {
        failed += 1;
      } else {
        skipped ??= data?.skipped?.[0]?.reason ?? data?.reason;
      }
    }

    return { processed, failed, skipped };
  } catch (error) {
    handleError(error, "processQueueBatch");
    throw error;
  }
}
