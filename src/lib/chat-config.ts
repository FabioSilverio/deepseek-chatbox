export type SearchMode = "none" | "web" | "deep";
export type ThinkingMode = "enabled" | "disabled";
export type ReasoningEffort = "high" | "max";

export type ChatMode = {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  model: "deepseek-v4-flash" | "deepseek-v4-pro";
  thinking: ThinkingMode;
  reasoningEffort?: ReasoningEffort;
  search: SearchMode;
  maxTokens: number;
};

export const CHAT_MODES = [
  {
    id: "instant",
    label: "Instant",
    shortLabel: "Fast",
    description: "deepseek-v4-flash, thinking off",
    model: "deepseek-v4-flash",
    thinking: "disabled",
    search: "none",
    maxTokens: 4096,
  },
  {
    id: "think",
    label: "Think",
    shortLabel: "Think",
    description: "deepseek-v4-pro, thinking high",
    model: "deepseek-v4-pro",
    thinking: "enabled",
    reasoningEffort: "high",
    search: "none",
    maxTokens: 8192,
  },
  {
    id: "max",
    label: "Max",
    shortLabel: "Max",
    description: "deepseek-v4-pro, thinking max",
    model: "deepseek-v4-pro",
    thinking: "enabled",
    reasoningEffort: "max",
    search: "none",
    maxTokens: 12288,
  },
  {
    id: "web",
    label: "Web",
    shortLabel: "Web",
    description: "web context, fast answer",
    model: "deepseek-v4-flash",
    thinking: "disabled",
    search: "web",
    maxTokens: 6144,
  },
  {
    id: "research",
    label: "Research",
    shortLabel: "Research",
    description: "multi-search context, thinking max",
    model: "deepseek-v4-pro",
    thinking: "enabled",
    reasoningEffort: "max",
    search: "deep",
    maxTokens: 16384,
  },
] as const satisfies readonly ChatMode[];

export type ChatModeId = (typeof CHAT_MODES)[number]["id"];

export const DEFAULT_CHAT_MODE: ChatModeId = "instant";

export function getChatMode(modeId: string | undefined): ChatMode {
  return CHAT_MODES.find((mode) => mode.id === modeId) ?? CHAT_MODES[0];
}
