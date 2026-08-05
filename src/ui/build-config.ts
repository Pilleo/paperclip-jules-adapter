import { AdapterConfigSchema as SdkAdapterConfigSchema, ConfigFieldSchema } from "@paperclipai/adapter-utils";

export function getConfigSchema(): SdkAdapterConfigSchema {
  return {
      fields: [
        {
          key: "source",
          type: "text",
          label: "Repository Source",
          required: true
        },
        {
          key: "repository",
          type: "text",
          label: "Repository Allowlist",
          required: true
        },
        {
          key: "baseBranch",
          type: "text",
          label: "Base Branch",
          required: true,
          default: "master"
        },
        {
          key: "automationMode",
          type: "select",
          label: "Automation Mode",
          required: true,
          default: "AUTO_CREATE_PR",
          options: [
            { label: "Auto Create PR", value: "AUTO_CREATE_PR" },
            { label: "Unspecified", value: "AUTOMATION_MODE_UNSPECIFIED" }
          ]
        },
        {
          key: "requirePlanApproval",
          type: "toggle",
          label: "Require Plan Approval",
          required: true,
          default: false
        },
        {
          key: "pollIntervalSeconds",
          type: "number",
          label: "Poll Interval (Seconds)",
          required: true,
          default: 45
        },
        {
          key: "heartbeatPollWindowSeconds",
          type: "number",
          label: "Heartbeat Poll Window (Seconds)",
          required: true,
          default: 120
        },
        {
          key: "maxSessionAgeHours",
          type: "number",
          label: "Max Session Age (Hours)",
          required: true,
          default: 168
        },
        {
          key: "maxAutomaticRestarts",
          type: "number",
          label: "Max Automatic Restarts",
          required: true,
          default: 3
        },
        {
          key: "invariantsFile",
          type: "text",
          label: "Invariants File",
          required: false
        }
      ]
  };
}

export function buildConfig(): ConfigFieldSchema[] {
    // Backwards compatibility if specifically paperclip host requests this method internally
    return getConfigSchema().fields;
}
