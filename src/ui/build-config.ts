export function buildJulesAdapterConfig(
  values: Record<string, unknown>,
): Record<string, unknown> {
  return {
    source: typeof values['source'] === "string" ? values['source'].trim() : "",
    repository: typeof values['repository'] === "string" ? values['repository'].trim() : "",
    baseBranch: typeof values['baseBranch'] === "string" && values['baseBranch'].trim() ? values['baseBranch'].trim() : "master",
    automationMode: typeof values['automationMode'] === "string" ? values['automationMode'] : "AUTO_CREATE_PR",
    requirePlanApproval: values['requirePlanApproval'] === true,
    pollIntervalSeconds: Number(values['pollIntervalSeconds'] ?? 45),
    heartbeatPollWindowSeconds: Number(values['heartbeatPollWindowSeconds'] ?? 120),
    maxSessionAgeHours: Number(values['maxSessionAgeHours'] ?? 168),
    maxAutomaticRestarts: Number(values['maxAutomaticRestarts'] ?? 3),
  };
}
