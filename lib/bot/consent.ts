/**
 * Recording-consent chat message (M7 A8), sent by the `bot.consent` job on
 * the transition to `active`; capability-probed (`unsupported` on 404/405).
 * Step 0 stub throws.
 */
export async function runBotConsent(input: {
  sessionId: string
  workspaceId: string
}): Promise<void> {
  void input
  throw new Error("runBotConsent not implemented (M7)")
}
