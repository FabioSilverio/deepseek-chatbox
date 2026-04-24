// ── Combo types (current) ────────────────────────────────────────────────────

export type ThinkingLevel = "fast" | "think" | "max";
export type SearchLevel = "none" | "web" | "research";

export type ModeConfig = {
  thinking: ThinkingLevel;
  search: SearchLevel;
};

export const DEFAULT_MODE_CONFIG: ModeConfig = {
  thinking: "fast",
  search: "none",
};

export type ThinkingModeOption = {
  id: ThinkingLevel;
  label: string;
  description: string;
};

export type SearchModeOption = {
  id: Exclude<SearchLevel, "none">;
  label: string;
  description: string;
};

export const THINKING_MODES: readonly ThinkingModeOption[] = [
  {
    id: "fast",
    label: "Fast",
    description: "V4 Flash · resposta rápida, sem raciocínio",
  },
  {
    id: "think",
    label: "Think",
    description: "V4 Pro · raciocínio profundo (effort high)",
  },
  {
    id: "max",
    label: "Max",
    description: "V4 Pro · raciocínio máximo (effort max)",
  },
];

export const SEARCH_MODES: readonly SearchModeOption[] = [
  {
    id: "web",
    label: "Web",
    description: "Busca rápida na web antes de responder",
  },
  {
    id: "research",
    label: "Research",
    description: "Pesquisa profunda com múltiplas fontes",
  },
];

// ── Resolved mode (sent to API) ───────────────────────────────────────────────

export type SearchMode = "none" | "web" | "deep";
export type ThinkingMode = "enabled" | "disabled";
export type ReasoningEffort = "high" | "max";

export type ResolvedMode = {
  model: "deepseek-v4-flash" | "deepseek-v4-pro";
  thinking: ThinkingMode;
  reasoningEffort?: ReasoningEffort;
  search: SearchMode;
  maxTokens: number;
  label: string;
};

export function resolveMode(config: ModeConfig): ResolvedMode {
  const isPro = config.thinking !== "fast";
  const reasoningEffort: ReasoningEffort | undefined =
    config.thinking === "max"
      ? "max"
      : config.thinking === "think"
        ? "high"
        : undefined;
  const search: SearchMode =
    config.search === "research"
      ? "deep"
      : config.search === "web"
        ? "web"
        : "none";

  const maxTokens =
    config.search === "research" || config.thinking === "max"
      ? 16384
      : config.thinking === "think"
        ? 8192
        : config.search === "web"
          ? 6144
          : 4096;

  const thinkLabel =
    config.thinking === "max"
      ? "Max"
      : config.thinking === "think"
        ? "Think"
        : "Fast";
  const searchLabel =
    config.search === "research"
      ? " + Research"
      : config.search === "web"
        ? " + Web"
        : "";

  return {
    model: isPro ? "deepseek-v4-pro" : "deepseek-v4-flash",
    thinking: isPro ? "enabled" : "disabled",
    reasoningEffort,
    search,
    maxTokens,
    label: thinkLabel + searchLabel,
  };
}

export function sanitizeModeConfig(raw: {
  thinking?: string;
  search?: string;
}): ModeConfig {
  const thinking: ThinkingLevel =
    raw.thinking === "think" || raw.thinking === "max" ? raw.thinking : "fast";
  const search: SearchLevel =
    raw.search === "web" || raw.search === "research" ? raw.search : "none";
  return { thinking, search };
}

// ── Legacy (kept for backward compat in route.ts fallback) ───────────────────

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
