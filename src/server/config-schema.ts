import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export const julesConfigSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "source",
      label: "Jules source",
      type: "text",
      required: true,
      hint: "Jules source resource, for example sources/github/org/repo",
    },
    {
      key: "repository",
      label: "GitHub repository",
      type: "text",
      required: true,
      hint: "Repository allowlist entry, for example org/repo",
    },
    {
      key: "baseBranch",
      label: "Base branch",
      type: "text",
      required: true,
      default: "master",
    },
    {
      key: "automationMode",
      label: "Automation mode",
      type: "select",
      required: true,
      default: "AUTO_CREATE_PR",
      options: [
        {
          label: "Automatically create PR",
          value: "AUTO_CREATE_PR",
        }
      ],
    },
    {
      key: "requirePlanApproval",
      label: "Require plan approval",
      type: "toggle",
      default: false,
      hint: "Jules pauses after planning and waits for explicit approval.",
    },
    {
      key: "maxAutomaticRestarts",
      label: "Maximum automatic restarts",
      type: "number",
      required: true,
      default: 3,
    },
  ],
};
