/** Microsoft Graph recording subscriptions. Implemented in M1-B. */
export function isTeamsSubscriptionConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  void env
  return false
}

export async function renewTeamsSubscriptions(
  now = new Date()
): Promise<{ renewed: number; created: number; failed: number }> {
  void now
  return { renewed: 0, created: 0, failed: 0 }
}