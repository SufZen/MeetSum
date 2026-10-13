/**
 * Message keys of the agent-suggestion intent codes (M9). The UI translates
 * them (components/meeting-right-rail.tsx); the outbound RealizeOS payload
 * renders them in English (lib/integrations/realizeos-text.ts).
 */
export const AGENT_INTENT_KEYS: Record<string, { title: string; description: string }> = {
  export_to_realizeos: { title: "mtgAgentExportRealizeosTitle", description: "mtgAgentExportRealizeosDescription" },
  draft_followup_email: { title: "mtgAgentFollowupEmailTitle", description: "mtgAgentFollowupEmailDescription" },
  create_n8n_payload: { title: "mtgAgentN8nPayloadTitle", description: "mtgAgentN8nPayloadDescription" },
  draft_client_recap: { title: "mtgAgentClientRecapTitle", description: "mtgAgentClientRecapDescription" },
  extract_crm_notes: { title: "mtgAgentCrmNotesTitle", description: "mtgAgentCrmNotesDescription" },
}
