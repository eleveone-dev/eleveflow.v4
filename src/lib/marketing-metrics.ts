export type StageEntry = {
  leadId: string | null;
  stageId: string | null;
};

export function calculateResponseRate(
  contactedLeadIds: readonly (string | null)[],
  repliedLeadIds: readonly (string | null)[],
) {
  const contacted = new Set(contactedLeadIds.filter((leadId): leadId is string => Boolean(leadId)));
  if (contacted.size === 0) return 0;

  const replied = new Set<string>();
  for (const leadId of repliedLeadIds) {
    if (leadId && contacted.has(leadId)) replied.add(leadId);
  }
  return Math.round((replied.size / contacted.size) * 100);
}

export function countDistinctLeadsForStages(
  entries: readonly StageEntry[],
  stageIds: readonly string[],
) {
  const selectedStages = new Set(stageIds);
  const leadIds = new Set<string>();
  for (const entry of entries) {
    if (entry.leadId && entry.stageId && selectedStages.has(entry.stageId)) {
      leadIds.add(entry.leadId);
    }
  }
  return leadIds.size;
}
