export function buildConfig() {
  return [
    {
      name: "source",
      type: "text",
      label: "Repository Source",
      required: true
    },
    {
      name: "repository",
      type: "text",
      label: "Repository Allowlist",
      required: true
    },
    {
      name: "baseBranch",
      type: "text",
      label: "Base Branch",
      required: true,
      defaultValue: "master"
    },
    {
      name: "automationMode",
      type: "select",
      label: "Automation Mode",
      required: true,
      defaultValue: "AUTO_CREATE_PR",
      options: [
        { label: "Auto Create PR", value: "AUTO_CREATE_PR" },
        { label: "Manual", value: "MANUAL" },
        { label: "Wait for Approval", value: "WAIT_FOR_APPROVAL" }
      ]
    },
    {
      name: "requirePlanApproval",
      type: "toggle",
      label: "Require Plan Approval",
      required: true,
      defaultValue: false
    },
    {
      name: "pollIntervalSeconds",
      type: "number",
      label: "Poll Interval (Seconds)",
      required: true,
      defaultValue: 45
    },
    {
      name: "heartbeatPollWindowSeconds",
      type: "number",
      label: "Heartbeat Poll Window (Seconds)",
      required: true,
      defaultValue: 120
    },
    {
      name: "maxSessionAgeHours",
      type: "number",
      label: "Max Session Age (Hours)",
      required: true,
      defaultValue: 168
    },
    {
      name: "maxAutomaticRestarts",
      type: "number",
      label: "Max Automatic Restarts",
      required: true,
      defaultValue: 3
    },
    {
      name: "invariantsFile",
      type: "text",
      label: "Invariants File",
      required: false
    }
  ];
}
