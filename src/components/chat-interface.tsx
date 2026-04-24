"use client";

import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BookOpen,
  Brain,
  Check,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Gauge,
  Globe,
  Image as ImageIcon,
  Layers,
  LibraryBig,
  MessageSquare,
  Plus,
  Search,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  THINKING_MODES,
  SEARCH_MODES,
  DEFAULT_MODE_CONFIG,
  resolveMode,
  type ModeConfig,
  type ThinkingLevel,
  type SearchLevel,
} from "@/lib/chat-config";
import type { SearchResult } from "@/lib/search";

type Artifact = {
  type: "html" | "svg" | "code" | "markdown";
  title: string;
  language?: string;
  content: string;
};

type TextModule = {
  id: string;
  title: string;
  content: string;
  chars: number;
  lines: number;
  preview: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  sources?: SearchResult[];
  modules?: TextModule[];
  mode?: string;
  error?: string;
};

type Project = {
  id: string;
  type: "chat" | "project";
  name: string;
  description?: string;
  instructions: string;
  memoryModules: TextModule[];
  messages: ChatMessage[];
  modeConfig: ModeConfig;
};

type StreamEvent =
  | { type: "status"; message: string }
  | { type: "sources"; sources: SearchResult[] }
  | { type: "reasoning"; delta: string }
  | { type: "token"; delta: string }
  | { type: "usage"; usage: unknown }
  | { type: "error"; message: string }
  | { type: "done" };

const PASTE_MODULE_THRESHOLD = 1400;
const MAX_MODULES = 8;
const PROJECTS_KEY = "deepbox.projects";
const ACTIVE_PROJECT_KEY = "deepbox.activeProjectId";
const API_KEY_KEY = "deepbox.apiKey";
const DEFAULT_PROJECT_ID = "default-project";

const thinkingIcons: Record<ThinkingLevel, React.ElementType> = {
  fast: Zap,
  think: Brain,
  max: Gauge,
};

const searchIcons: Record<Exclude<SearchLevel, "none">, React.ElementType> = {
  web: Search,
  research: LibraryBig,
};

const starterPrompts = [
  "Me ajuda a desenhar uma estrategia para este projeto",
  "Resume e transforme em plano de acao",
  "Compare as opcoes e me de uma recomendacao",
];

export function ChatInterface() {
  const [projects, setProjects] = useState<Project[]>(readSavedProjects);
  const [activeProjectId, setActiveProjectId] = useState(readSavedActiveProjectId);
  const [input, setInput] = useState("");
  const [modules, setModules] = useState<TextModule[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState("");
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState(() =>
    typeof window !== "undefined" ? (window.localStorage.getItem(API_KEY_KEY) ?? "") : "",
  );
  const [showSettings, setShowSettings] = useState(false);
  const [projectSettingsId, setProjectSettingsId] = useState<string | null>(null);

  const endRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const titledProjectsRef = useRef<Set<string>>(new Set());
  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? projects[0],
    [activeProjectId, projects],
  );
  const messages = activeProject.messages;
  const projectMemoryModules = activeProject.memoryModules;
  const modeConfig = activeProject.modeConfig;
  const activeMode = useMemo(() => resolveMode(modeConfig), [modeConfig]);

  useEffect(() => {
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  }, [projects]);

  useEffect(() => {
    window.localStorage.setItem(ACTIVE_PROJECT_KEY, activeProjectId);
  }, [activeProjectId]);

  useEffect(() => {
    window.localStorage.setItem(API_KEY_KEY, apiKey);
  }, [apiKey]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: isStreaming ? "instant" : "smooth" });
  }, [messages, isStreaming]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !status) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [status]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [input]);

  // Auto-generate title after first complete exchange in a chat conversation
  useEffect(() => {
    if (isStreaming) return;
    const project = activeProject;
    if (project.type !== "chat") return;
    if (titledProjectsRef.current.has(project.id)) return;

    const userMsgs = project.messages.filter((m) => m.role === "user");
    const assistantMsgs = project.messages.filter(
      (m) => m.role === "assistant" && m.content && !m.error,
    );
    if (userMsgs.length !== 1 || assistantMsgs.length !== 1) return;

    titledProjectsRef.current.add(project.id);
    const projectId = project.id;
    const userContent = userMsgs[0].content;
    const assistantContent = assistantMsgs[0].content;

    void (async () => {
      try {
        const res = await fetch("/api/title", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { "X-Deepseek-Key": apiKey } : {}),
          },
          body: JSON.stringify({
            userMessage: userContent.slice(0, 400),
            assistantSnippet: assistantContent.slice(0, 500),
          }),
        });
        if (!res.ok) return;
        const { title } = (await res.json()) as { title: string | null };
        if (!title) return;
        updateProject(projectId, (p) => ({ ...p, name: title }));
      } catch {
        // non-critical — silently ignore
      }
    })();
  }, [isStreaming, activeProject, apiKey]);

  async function submitMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    const trimmed = input.trim();
    if ((!trimmed && modules.length === 0) || isStreaming) return;

    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: trimmed || "Analise os modulos anexados.",
      modules,
    };

    const assistantId = createId();
    // Auto-name conversations on first user message
    if (
      activeProject.type === "chat" &&
      activeProject.name === "Nova conversa" &&
      activeProject.messages.length === 0
    ) {
      const autoName = trimmed.slice(0, 46).trim();
      if (autoName) {
        updateProject(activeProject.id, (p) => ({ ...p, name: autoName }));
      }
    }

    const resolvedForMsg = resolveMode(modeConfig);
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      mode: resolvedForMsg.label,
    };

    const nextMessages = [...messages, userMessage];
    const projectId = activeProject.id;
    setProjectMessages(projectId, [...nextMessages, assistantMessage]);
    setInput("");
    setModules([]);
    setIsStreaming(true);
    setStatus("Preparando...");

    const controller = new AbortController();
    setAbortController(controller);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "X-Deepseek-Key": apiKey } : {}),
        },
        body: JSON.stringify({
          combo: modeConfig,
          messages: nextMessages.map(toApiMessage),
          project: {
            name: activeProject.name,
            instructions: activeProject.instructions,
            modules: activeProject.memoryModules.map((m) => ({
              title: m.title,
              content: m.content,
            })),
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const message = await response.text();
        throw new Error(message || "Falha ao chamar o backend.");
      }

      await readStream(response.body, (ev) => {
        if (ev.type === "status") { setStatus(ev.message); return; }
        if (ev.type === "sources") { patchAssistant(projectId, assistantId, { sources: ev.sources }); return; }
        if (ev.type === "reasoning") { appendAssistant(projectId, assistantId, "reasoning", ev.delta); setStatus("Pensando..."); return; }
        if (ev.type === "token") { appendAssistant(projectId, assistantId, "content", ev.delta); setStatus(""); return; }
        if (ev.type === "error") { patchAssistant(projectId, assistantId, { error: ev.message }); setStatus(""); return; }
        if (ev.type === "done") { setStatus(""); }
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        patchAssistant(projectId, assistantId, { error: "Resposta interrompida." });
      } else {
        patchAssistant(projectId, assistantId, {
          error: error instanceof Error ? error.message : "Falha inesperada ao enviar.",
        });
      }
    } finally {
      setIsStreaming(false);
      setAbortController(null);
      setStatus("");
      textareaRef.current?.focus();
    }
  }

  function updateProjectModeConfig(
    projectId: string,
    next: Partial<ModeConfig>,
  ) {
    updateProject(projectId, (p) => ({
      ...p,
      modeConfig: { ...p.modeConfig, ...next },
    }));
  }

  function updateProject(projectId: string, updater: (project: Project) => Project) {
    setProjects((current) =>
      current.map((p) => (p.id === projectId ? updater(p) : p)),
    );
  }

  function setProjectMessages(
    projectId: string,
    nextMessages: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[]),
  ) {
    updateProject(projectId, (p) => ({
      ...p,
      messages: typeof nextMessages === "function" ? nextMessages(p.messages) : nextMessages,
    }));
  }

  function patchAssistant(projectId: string, id: string, patch: Partial<ChatMessage>) {
    setProjectMessages(projectId, (current) =>
      current.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    );
  }

  function appendAssistant(
    projectId: string,
    id: string,
    field: "content" | "reasoning",
    delta: string,
  ) {
    setProjectMessages(projectId, (current) =>
      current.map((m) =>
        m.id === id ? { ...m, [field]: `${m[field] ?? ""}${delta}` } : m,
      ),
    );
  }

  function stopStreaming() { abortController?.abort(); }

  function clearChat() {
    stopStreaming();
    setProjectMessages(activeProject.id, []);
    setModules([]);
    setStatus("");
  }

  function createChat() {
    const nextItem: Project = {
      id: createId(),
      type: "chat",
      name: "Nova conversa",
      description: "",
      instructions: "",
      memoryModules: [],
      messages: [],
      modeConfig: { ...DEFAULT_MODE_CONFIG },
    };
    setProjects((current) => [...current, nextItem]);
    setActiveProjectId(nextItem.id);
    setModules([]);
    setInput("");
  }

  function createProject() {
    const projectCount =
      projects.filter((p) => p.type === "project").length + 1;
    const nextProject: Project = {
      id: createId(),
      type: "project",
      name: `Projeto ${projectCount}`,
      description: "",
      instructions: "",
      memoryModules: [],
      messages: [],
      modeConfig: { ...DEFAULT_MODE_CONFIG },
    };
    setProjects((current) => [...current, nextProject]);
    setActiveProjectId(nextProject.id);
    setModules([]);
    setInput("");
  }

  function deleteProject(id: string) {
    const remaining = projects.filter((p) => p.id !== id);
    const nextProjects = remaining.length > 0 ? remaining : [createDefaultProject()];
    setProjects(nextProjects);
    if (activeProjectId === id) setActiveProjectId(nextProjects[0].id);
    setModules([]);
  }

  function pinModuleToProject(module: TextModule) {
    updateProject(activeProject.id, (p) => ({
      ...p,
      memoryModules: [...p.memoryModules, module].slice(-MAX_MODULES),
    }));
    setModules((current) => current.filter((m) => m.id !== module.id));
    setStatus("Modulo salvo no projeto.");
  }

  function removeProjectModule(projectId: string, moduleId: string) {
    updateProject(projectId, (p) => ({
      ...p,
      memoryModules: p.memoryModules.filter((m) => m.id !== moduleId),
    }));
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = event.clipboardData.getData("text/plain");
    if (!isLargePaste(pasted)) return;
    event.preventDefault();
    const nextModule = makeTextModule(pasted, modules.length + 1);
    setModules((current) => [...current, nextModule].slice(-MAX_MODULES));
    setStatus("Texto grande virou modulo.");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage();
    }
  }

  async function copyMessage(message: ChatMessage) {
    await navigator.clipboard.writeText(message.content);
    setCopiedId(message.id);
    window.setTimeout(() => setCopiedId(null), 1200);
  }

  const canSubmit = (input.trim().length > 0 || modules.length > 0) && !isStreaming;

  return (
    <div className="flex h-dvh overflow-hidden bg-[var(--app-bg)] text-[var(--ctp-text)]">

      {/* ── Sidebar ── */}
      <aside className="hidden w-[268px] shrink-0 flex-col border-r border-white/10 bg-[var(--sidebar-bg)] backdrop-blur-2xl lg:flex">

        {/* Logo + New Chat */}
        <div className="flex items-center justify-between px-4 pt-5 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-[linear-gradient(135deg,var(--ctp-mauve),var(--ctp-teal))] text-[var(--ctp-crust)] shadow-[0_8px_24px_rgba(203,166,247,0.28)]">
              <Sparkles size={15} strokeWidth={2.4} />
            </div>
            <span className="text-[16px] font-semibold leading-none tracking-[-0.01em] text-[var(--ctp-text)]">
              Deepbox
            </span>
          </div>
          <button
            type="button"
            className="icon-button"
            title="Nova conversa"
            aria-label="Nova conversa"
            onClick={createChat}
          >
            <Plus size={16} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-1 space-y-4">

          {/* ── Projects section ── */}
          <section>
            <div className="mb-1 flex items-center justify-between px-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ctp-overlay1)]">
                Projetos
              </p>
              <button
                type="button"
                className="grid size-5 place-items-center rounded-[5px] text-[var(--ctp-overlay1)] transition hover:bg-white/10 hover:text-[var(--ctp-text)]"
                title="Novo projeto"
                aria-label="Novo projeto"
                onClick={createProject}
              >
                <Plus size={11} />
              </button>
            </div>
            <div className="space-y-0.5">
              {projects.filter((p) => p.type === "project").map((project) => {
                const isActive = project.id === activeProject.id;
                const hasInstructions = !!project.instructions?.trim();
                const moduleCount = project.memoryModules?.length ?? 0;
                return (
                  <div
                    key={project.id}
                    className={`group relative flex items-center rounded-[12px] border transition-colors ${
                      isActive
                        ? "border-[var(--ctp-mauve)]/25 bg-[var(--ctp-mauve)]/10"
                        : "border-transparent hover:border-white/8 hover:bg-white/[0.04]"
                    }`}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left"
                      onClick={() => setActiveProjectId(project.id)}
                    >
                      <span
                        className={`flex size-6 shrink-0 items-center justify-center rounded-[7px] transition-colors ${
                          isActive
                            ? "bg-[var(--ctp-mauve)]/20 text-[var(--ctp-mauve)]"
                            : "bg-white/[0.06] text-[var(--ctp-overlay1)]"
                        }`}
                      >
                        <Layers size={12} strokeWidth={2} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p
                          className={`truncate text-[13px] leading-5 transition-colors ${
                            isActive
                              ? "font-semibold text-[var(--ctp-text)]"
                              : "text-[var(--ctp-subtext0)]"
                          }`}
                        >
                          {project.name}
                        </p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {hasInstructions && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-[var(--ctp-mauve)]/70">
                              <BookOpen size={9} />
                              instruções
                            </span>
                          )}
                          {moduleCount > 0 && (
                            <span className="text-[10px] text-[var(--ctp-overlay1)]">
                              {moduleCount} módulo{moduleCount > 1 ? "s" : ""}
                            </span>
                          )}
                          {!hasInstructions && moduleCount === 0 && (
                            <p className="text-[11px] leading-4 text-[var(--ctp-overlay2)] italic">
                              {project.description || "Sem configuração"}
                            </p>
                          )}
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="mr-2 grid size-7 shrink-0 place-items-center rounded-[8px] text-[var(--ctp-overlay1)] opacity-0 transition hover:bg-white/10 hover:text-[var(--ctp-text)] group-hover:opacity-100"
                      title="Configurações do projeto"
                      aria-label="Configurações do projeto"
                      onClick={() => setProjectSettingsId(project.id)}
                    >
                      <Settings size={12} />
                    </button>
                  </div>
                );
              })}
              {projects.filter((p) => p.type === "project").length === 0 && (
                <p className="px-3 py-2 text-[11px] italic text-[var(--ctp-overlay2)]">
                  Nenhum projeto
                </p>
              )}
            </div>
          </section>

          {/* ── Conversations section ── */}
          <section>
            <div className="mb-1 px-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ctp-overlay1)]">
                Conversas
              </p>
            </div>
            <div className="space-y-0.5">
              {projects.filter((p) => p.type === "chat").map((project) => {
                const lastUserMsg = [...project.messages]
                  .reverse()
                  .find((m) => m.role === "user");
                const isActive = project.id === activeProject.id;
                return (
                  <div
                    key={project.id}
                    className={`group relative flex items-center rounded-[12px] border transition-colors ${
                      isActive
                        ? "border-[var(--ctp-blue)]/20 bg-[var(--ctp-blue)]/8"
                        : "border-transparent hover:border-white/8 hover:bg-white/[0.04]"
                    }`}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left"
                      onClick={() => setActiveProjectId(project.id)}
                    >
                      <MessageSquare
                        size={13}
                        className={`mt-0.5 shrink-0 transition-colors ${
                          isActive
                            ? "text-[var(--ctp-blue)]"
                            : "text-[var(--ctp-overlay1)]"
                        }`}
                      />
                      <div className="min-w-0">
                        <p
                          className={`truncate text-[13px] leading-5 transition-colors ${
                            isActive
                              ? "font-medium text-[var(--ctp-text)]"
                              : "text-[var(--ctp-subtext0)]"
                          }`}
                        >
                          {project.name}
                        </p>
                        {lastUserMsg ? (
                          <p className="mt-0.5 truncate text-[11px] leading-4 text-[var(--ctp-overlay1)]">
                            {lastUserMsg.content.slice(0, 48)}
                          </p>
                        ) : (
                          <p className="mt-0.5 text-[11px] leading-4 text-[var(--ctp-overlay2)] italic">
                            Sem mensagens
                          </p>
                        )}
                      </div>
                    </button>
                    {/* Delete button for conversations */}
                    <button
                      type="button"
                      className="mr-2 grid size-7 shrink-0 place-items-center rounded-[8px] text-[var(--ctp-overlay1)] opacity-0 transition hover:bg-[var(--ctp-red)]/15 hover:text-[var(--ctp-red)] group-hover:opacity-100"
                      title="Excluir conversa"
                      aria-label="Excluir conversa"
                      onClick={() => deleteProject(project.id)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
              {projects.filter((p) => p.type === "chat").length === 0 && (
                <p className="px-3 py-2 text-[11px] italic text-[var(--ctp-overlay2)]">
                  Nenhuma conversa ainda
                </p>
              )}
            </div>
          </section>
        </nav>

        {/* Bottom: Settings */}
        <div className="border-t border-white/10 px-2 py-3">
          <button
            type="button"
            className="relative flex w-full items-center gap-2.5 rounded-[12px] border border-transparent px-3 py-2.5 text-sm text-[var(--ctp-subtext0)] transition hover:border-white/8 hover:bg-white/[0.04] hover:text-[var(--ctp-text)]"
            onClick={() => setShowSettings(true)}
          >
            <Settings size={15} />
            <span>Configurações</span>
            {!apiKey && (
              <span
                className="ml-auto size-2 rounded-full bg-[var(--ctp-peach)]"
                title="API Key não configurada"
              />
            )}
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.08] bg-[rgba(9,9,14,0.9)] px-4 backdrop-blur-2xl sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-8 place-items-center rounded-[10px] border border-white/[0.08] bg-white/[0.04] lg:hidden">
              <Sparkles size={15} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-[15px] font-semibold leading-tight tracking-[-0.01em]">
                  {activeProject.name}
                </p>
                {activeProject.type === "project" && (
                  <span className="hidden shrink-0 items-center gap-1 rounded-[5px] border border-[var(--ctp-mauve)]/30 bg-[var(--ctp-mauve)]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ctp-mauve)] sm:inline-flex">
                    <Layers size={9} strokeWidth={2.5} />
                    Projeto
                  </span>
                )}
              </div>
              <p className="truncate text-xs text-[var(--ctp-subtext0)]">
                {activeMode.label} · {activeMode.model}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="icon-button lg:hidden"
              title="Nova conversa"
              aria-label="Nova conversa"
              onClick={createProject}
            >
              <Plus size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="Configurações do projeto"
              aria-label="Configurações do projeto"
              onClick={() => setProjectSettingsId(activeProject.id)}
            >
              <Settings size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="Limpar conversa"
              aria-label="Limpar conversa"
              onClick={clearChat}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </header>

        <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_22%_8%,rgba(137,180,250,0.12),transparent_28%),radial-gradient(circle_at_72%_4%,rgba(148,226,213,0.10),transparent_26%)]" />
          <div ref={scrollContainerRef} className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-8 sm:px-6">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-7">
              {messages.length === 0 ? (
                <EmptyState onPickPrompt={setInput} />
              ) : (
                messages.map((message, i) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    copied={copiedId === message.id}
                    onCopy={() => void copyMessage(message)}
                    isLive={
                      isStreaming &&
                      i === messages.length - 1 &&
                      message.role === "assistant"
                    }
                  />
                ))
              )}
              {status ? (
                <div className="status-enter flex items-center gap-3 pl-1 text-sm text-[var(--ctp-subtext0)]">
                  <span className="thinking-dot" />
                  <span>{status}</span>
                </div>
              ) : null}
              <div ref={endRef} />
            </div>
          </div>

          <div className="relative shrink-0 px-3 pb-4 sm:px-6 sm:pb-6">
            <form
              onSubmit={submitMessage}
              className="mx-auto w-full max-w-4xl rounded-[22px] border border-white/[0.09] bg-[rgba(11,11,17,0.96)] p-2 shadow-[0_24px_70px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
            >
              {modules.length > 0 ? (
                <div className="grid gap-2 p-2 sm:grid-cols-2">
                  {modules.map((module) => (
                    <TextModuleChip
                      key={module.id}
                      module={module}
                      canPin={activeProject.type === "project"}
                      onRemove={() =>
                        setModules((current) =>
                          current.filter((m) => m.id !== module.id),
                        )
                      }
                      onPin={() => pinModuleToProject(module)}
                    />
                  ))}
                </div>
              ) : null}

              <textarea
                ref={textareaRef}
                data-testid="chat-input"
                value={input}
                rows={1}
                onChange={(event) => setInput(event.target.value)}
                onPaste={handlePaste}
                onKeyDown={handleKeyDown}
                placeholder="Fala comigo..."
                className="max-h-[220px] min-h-16 w-full resize-none bg-transparent px-4 py-3 text-[15px] leading-7 text-[var(--ctp-text)] outline-none placeholder:text-[var(--ctp-overlay1)]"
              />

              <div className="flex flex-col gap-3 border-t border-white/10 px-2 pb-1 pt-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-1.5">
                  {/* Thinking row (radio) */}
                  {THINKING_MODES.map((mode) => {
                    const Icon = thinkingIcons[mode.id];
                    const active = modeConfig.thinking === mode.id;
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        title={mode.description}
                        onClick={() =>
                          updateProjectModeConfig(activeProject.id, {
                            thinking: mode.id,
                          })
                        }
                        className={`segmented-button ${active ? "segmented-button-active" : ""}`}
                      >
                        <Icon size={14} />
                        <span>{mode.label}</span>
                      </button>
                    );
                  })}

                  <span className="mx-0.5 text-[var(--ctp-overlay2)] select-none">·</span>

                  {/* Search row (toggle) */}
                  {SEARCH_MODES.map((mode) => {
                    const Icon = searchIcons[mode.id];
                    const active = modeConfig.search === mode.id;
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        title={mode.description}
                        onClick={() =>
                          updateProjectModeConfig(activeProject.id, {
                            search: active ? "none" : mode.id,
                          })
                        }
                        className={`segmented-button ${active ? "segmented-button-active" : ""}`}
                      >
                        <Icon size={14} />
                        <span>{mode.label}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center justify-end gap-2">
                  {isStreaming ? (
                    <button
                      type="button"
                      className="send-button send-button-stop"
                      title="Parar"
                      aria-label="Parar"
                      onClick={stopStreaming}
                    >
                      <Square size={17} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="send-button"
                      title="Enviar"
                      aria-label="Enviar"
                      disabled={!canSubmit}
                    >
                      <Send size={18} />
                    </button>
                  )}
                </div>
              </div>
            </form>
          </div>
        </section>
      </main>

      {/* ── Modals ── */}
      {projectSettingsId !== null && (
        <ProjectSettingsModal
          project={projects.find((p) => p.id === projectSettingsId) ?? projects[0]}
          onClose={() => setProjectSettingsId(null)}
          onUpdate={(updater) => updateProject(projectSettingsId, updater)}
          onDelete={() => {
            deleteProject(projectSettingsId);
            setProjectSettingsId(null);
          }}
          onRemoveModule={(moduleId) =>
            removeProjectModule(projectSettingsId, moduleId)
          }
        />
      )}

      {showSettings && (
        <SettingsModal
          apiKey={apiKey}
          onChange={setApiKey}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

// ── ProjectSettingsModal ──────────────────────────────────────────────────────

function ProjectSettingsModal({
  project,
  onClose,
  onUpdate,
  onDelete,
  onRemoveModule,
}: {
  project: Project;
  onClose: () => void;
  onUpdate: (updater: (p: Project) => Project) => void;
  onDelete: () => void;
  onRemoveModule: (moduleId: string) => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [instructions, setInstructions] = useState(project.instructions);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function save() {
    onUpdate((p) => ({
      ...p,
      name: name.trim() || p.name,
      description: description.trim(),
      instructions,
    }));
    onClose();
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel">
        <div className="modal-header">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-[8px] bg-[var(--ctp-mauve)]/15 text-[var(--ctp-mauve)]">
              <Layers size={13} strokeWidth={2} />
            </span>
            <h2 className="text-base font-semibold text-[var(--ctp-text)]">
              Configurações do projeto
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            title="Fechar"
            aria-label="Fechar"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body space-y-4">
          <div>
            <label className="modal-label">Nome</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="modal-input"
              placeholder="Nome do projeto"
            />
          </div>

          <div>
            <label className="modal-label">Descrição</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="modal-input"
              placeholder="Breve descrição do projeto (aparece na sidebar)"
              maxLength={80}
            />
          </div>

          <div>
            <label className="modal-label">Instruções do sistema</label>
            <p className="mb-2 text-[12px] text-[var(--ctp-overlay1)]">
              Defina o contexto, tom de resposta, regras ou qualquer preferência
              persistente para este projeto.
            </p>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={6}
              placeholder="Ex: Você é um assistente especializado em marketing. Use linguagem informal e seja objetivo."
              className="modal-textarea"
            />
          </div>

          {project.memoryModules.length > 0 && (
            <div>
              <label className="modal-label">
                Memória ({project.memoryModules.length} módulo
                {project.memoryModules.length !== 1 ? "s" : ""})
              </label>
              <div className="space-y-1.5">
                {project.memoryModules.map((module) => (
                  <ProjectMemoryRow
                    key={module.id}
                    module={module}
                    onRemove={() => onRemoveModule(module.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--ctp-red)]">
                Excluir projeto?
              </span>
              <button
                type="button"
                className="danger-button"
                onClick={onDelete}
              >
                Sim, excluir
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setConfirmDelete(false)}
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="danger-ghost-button"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={13} />
              Excluir projeto
            </button>
          )}
          <div className="flex gap-2">
            <button type="button" className="ghost-button" onClick={onClose}>
              Cancelar
            </button>
            <button type="button" className="primary-button" onClick={save}>
              Salvar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── SettingsModal ─────────────────────────────────────────────────────────────

function SettingsModal({
  apiKey,
  onChange,
  onClose,
}: {
  apiKey: string;
  onChange: (key: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(apiKey);
  const [show, setShow] = useState(false);

  function save() {
    onChange(draft.trim());
    onClose();
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel" style={{ maxWidth: 440 }}>
        <div className="modal-header">
          <h2 className="text-base font-semibold text-[var(--ctp-text)]">
            Configurações
          </h2>
          <button
            type="button"
            className="icon-button"
            title="Fechar"
            aria-label="Fechar"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body space-y-5">
          <div>
            <label className="modal-label">DeepSeek API Key</label>
            <p className="mb-2 text-[12px] text-[var(--ctp-subtext0)]">
              Sua chave é salva apenas no seu navegador e nunca enviada para
              servidores externos.
            </p>
            <div className="relative">
              <input
                type={show ? "text" : "password"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="sk-..."
                className="modal-input pr-10"
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ctp-overlay1)] transition hover:text-[var(--ctp-text)]"
                onClick={() => setShow(!show)}
                title={show ? "Ocultar chave" : "Mostrar chave"}
                aria-label={show ? "Ocultar chave" : "Mostrar chave"}
              >
                {show ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-[var(--ctp-overlay1)]">
              Obtenha em{" "}
              <a
                href="https://platform.deepseek.com"
                target="_blank"
                rel="noreferrer"
                className="text-[var(--ctp-blue)] underline underline-offset-2"
              >
                platform.deepseek.com
              </a>
            </p>
          </div>
        </div>

        <div className="modal-footer" style={{ justifyContent: "flex-end" }}>
          <div className="flex gap-2">
            <button type="button" className="ghost-button" onClick={onClose}>
              Cancelar
            </button>
            <button type="button" className="primary-button" onClick={save}>
              Salvar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── EmptyState ────────────────────────────────────────────────────────────────

function EmptyState({
  onPickPrompt,
}: {
  onPickPrompt: (prompt: string) => void;
}) {
  return (
    <div className="mx-auto flex min-h-[42vh] w-full max-w-2xl flex-col justify-center">
      <p className="text-[32px] font-semibold leading-tight tracking-[-0.02em] text-[var(--ctp-text)] sm:text-[40px]">
        O que vamos pensar hoje?
      </p>
      <p className="mt-2 text-[15px] text-[var(--ctp-overlay1)]">
        Selecione um modo e comece a conversar.
      </p>
      <div className="mt-7 flex flex-wrap gap-2">
        {starterPrompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-4 py-2 text-left text-[13px] text-[var(--ctp-subtext0)] transition hover:border-white/[0.14] hover:bg-white/[0.06] hover:text-[var(--ctp-text)]"
            onClick={() => onPickPrompt(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── MessageBubble ─────────────────────────────────────────────────────────────

function MessageBubble({
  message,
  copied,
  onCopy,
  isLive = false,
}: {
  message: ChatMessage;
  copied: boolean;
  onCopy: () => void;
  isLive?: boolean;
}) {
  const isUser = message.role === "user";
  const [openArtifact, setOpenArtifact] = useState<Artifact | null>(null);

  const { display, artifacts } = useMemo(
    () =>
      isLive || !message.content
        ? { display: message.content, artifacts: [] }
        : extractArtifacts(message.content),
    [message.content, isLive],
  );

  return (
    <article
      className={`message-enter group flex gap-4 ${
        isUser ? "justify-end" : "justify-start"
      }`}
    >
      {!isUser ? (
        <div
          className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-[9px] bg-[linear-gradient(135deg,var(--ctp-mauve),var(--ctp-blue))] text-white ${
            isLive ? "avatar-live" : "shadow-[0_6px_20px_rgba(137,180,250,0.22)]"
          }`}
        >
          <Sparkles size={14} />
        </div>
      ) : null}

      <div
        className={`min-w-0 ${
          isUser
            ? "max-w-[min(680px,90%)] rounded-[16px] border border-white/[0.08] bg-[rgba(18,18,26,0.95)] px-5 py-3.5 shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
            : "w-full max-w-3xl"
        }`}
      >
        {message.modules?.length ? (
          <div className="mb-3 grid gap-2">
            {message.modules.map((module) => (
              <AttachedModule key={module.id} module={module} />
            ))}
          </div>
        ) : null}

        {message.reasoning ? (
          <details className="mb-4 rounded-[12px] border border-[var(--ctp-mauve)]/15 bg-[rgba(14,14,22,0.7)] p-3 text-sm text-[var(--ctp-subtext0)]">
            <summary className="cursor-pointer select-none font-medium text-[var(--ctp-mauve)]">
              Raciocinio
            </summary>
            <p className="mt-3 whitespace-pre-wrap font-serif leading-7">
              {message.reasoning}
            </p>
          </details>
        ) : null}

        {display || (isLive && message.content) ? (
          <div
            className={`markdown-body ${
              isUser
                ? "text-[15px] leading-[1.65]"
                : "font-serif text-[17.5px]"
            }`}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {display || message.content}
            </ReactMarkdown>
            {isLive && <span className="streaming-cursor" />}
          </div>
        ) : message.role === "assistant" && !message.error && !message.reasoning ? (
          <div className="flex items-center gap-3 text-sm text-[var(--ctp-subtext0)]">
            <span className="thinking-dot" />
            <span>...</span>
          </div>
        ) : null}

        {message.error ? (
          <div className="mt-3 rounded-[14px] border border-[var(--ctp-red)]/30 bg-[var(--ctp-red)]/10 px-4 py-3 text-sm text-[var(--ctp-red)]">
            {message.error}
          </div>
        ) : null}

        {message.sources?.length ? (
          <SourceList sources={message.sources} />
        ) : null}

        {artifacts.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {artifacts.map((artifact, i) => (
              <button
                key={i}
                type="button"
                className="artifact-card"
                onClick={() => setOpenArtifact(artifact)}
              >
                <span className="artifact-card-icon">
                  {artifact.type === "html" ? (
                    <Globe size={18} />
                  ) : artifact.type === "svg" ? (
                    <ImageIcon size={18} />
                  ) : artifact.type === "code" ? (
                    <Code2 size={18} />
                  ) : (
                    <FileText size={18} />
                  )}
                </span>
                <span className="artifact-card-info">
                  <span className="artifact-card-title">{artifact.title}</span>
                  <span className="artifact-card-meta">
                    {artifact.type.toUpperCase()}
                    {artifact.language ? ` · ${artifact.language}` : ""}
                    {" · Clique para abrir"}
                  </span>
                </span>
                <ExternalLink size={14} className="ml-auto shrink-0 opacity-50" />
              </button>
            ))}
          </div>
        )}

        {openArtifact && (
          <ArtifactViewer
            artifact={openArtifact}
            onClose={() => setOpenArtifact(null)}
          />
        )}

        {!isUser && message.content ? (
          <div className="mt-3 flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
            <button
              type="button"
              className="mini-action"
              title="Copiar"
              aria-label="Copiar"
              onClick={onCopy}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              <span>{copied ? "Copiado" : "Copiar"}</span>
            </button>
            {message.mode ? (
              <span className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-[var(--ctp-overlay1)]">
                {message.mode}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

// ── ArtifactViewer ───────────────────────────────────────────────────────────

function ArtifactViewer({
  artifact,
  onClose,
}: {
  artifact: Artifact;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copyContent() {
    void navigator.clipboard.writeText(artifact.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  const ArtifactIcon =
    artifact.type === "html"
      ? Globe
      : artifact.type === "svg"
        ? ImageIcon
        : artifact.type === "code"
          ? Code2
          : FileText;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="artifact-viewer">
        <div className="artifact-viewer-header">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="artifact-type-badge">
              <ArtifactIcon size={13} />
              {artifact.type}
            </span>
            <h3 className="font-semibold text-[var(--ctp-text)] truncate">
              {artifact.title}
            </h3>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={copyContent}
              className="ghost-button flex items-center gap-1.5"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? "Copiado" : "Copiar"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="icon-button"
              aria-label="Fechar"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="artifact-viewer-body">
          {artifact.type === "html" && (
            <iframe
              srcDoc={artifact.content}
              sandbox="allow-scripts allow-same-origin"
              className="w-full h-full border-0 rounded-b-[18px]"
              title={artifact.title}
            />
          )}
          {artifact.type === "svg" && (
            <div
              className="flex items-center justify-center w-full h-full p-8 overflow-auto"
              dangerouslySetInnerHTML={{ __html: artifact.content }}
            />
          )}
          {artifact.type === "markdown" && (
            <div className="markdown-body p-8 overflow-y-auto h-full text-[16px]">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
              >
                {artifact.content}
              </ReactMarkdown>
            </div>
          )}
          {artifact.type === "code" && (
            <pre className="p-6 overflow-auto h-full text-[13px] leading-relaxed text-[var(--ctp-text)] font-mono">
              <code>{artifact.content}</code>
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ProjectMemoryRow ──────────────────────────────────────────────────────────

function ProjectMemoryRow({
  module,
  onRemove,
}: {
  module: TextModule;
  onRemove: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-[12px] border border-[var(--ctp-teal)]/15 bg-[var(--ctp-teal)]/8 px-2.5 py-2">
      <FileText size={13} className="shrink-0 text-[var(--ctp-teal)]" />
      <span className="min-w-0 flex-1 truncate text-xs text-[var(--ctp-subtext1)]">
        {module.title}
      </span>
      <button
        type="button"
        className="grid size-6 shrink-0 place-items-center rounded-full text-[var(--ctp-overlay2)] transition hover:bg-white/10 hover:text-[var(--ctp-text)]"
        title="Remover memoria"
        aria-label="Remover memoria"
        onClick={onRemove}
      >
        <X size={13} />
      </button>
    </div>
  );
}

// ── TextModuleChip ────────────────────────────────────────────────────────────

function TextModuleChip({
  module,
  onRemove,
  onPin,
  canPin = true,
}: {
  module: TextModule;
  onRemove: () => void;
  onPin: () => void;
  canPin?: boolean;
}) {
  return (
    <div className="group flex min-w-0 items-start gap-3 rounded-[16px] border border-[var(--ctp-teal)]/20 bg-[var(--ctp-teal)]/8 p-3">
      <div className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-[var(--ctp-teal)]/14 text-[var(--ctp-teal)]">
        <FileText size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--ctp-text)]">
          {module.title}
        </p>
        <p className="mt-0.5 text-xs text-[var(--ctp-subtext0)]">
          {formatCount(module.chars)} chars - {module.lines} linhas
        </p>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--ctp-overlay2)]">
          {module.preview}
        </p>
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        {canPin && (
        <button
          type="button"
          className="grid size-7 place-items-center rounded-full text-[var(--ctp-teal)] transition hover:bg-white/10 hover:text-[var(--ctp-text)]"
          title="Salvar no projeto"
          aria-label="Salvar no projeto"
          onClick={onPin}
        >
          <LibraryBig size={14} />
        </button>
        )}
        <button
          type="button"
          className="grid size-7 place-items-center rounded-full text-[var(--ctp-overlay2)] transition hover:bg-white/10 hover:text-[var(--ctp-text)]"
          title="Remover modulo"
          aria-label="Remover modulo"
          onClick={onRemove}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

// ── AttachedModule ────────────────────────────────────────────────────────────

function AttachedModule({ module }: { module: TextModule }) {
  return (
    <div className="rounded-[15px] border border-[var(--ctp-teal)]/20 bg-[var(--ctp-teal)]/8 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-[var(--ctp-teal)]">
        <FileText size={15} />
        <span className="truncate">{module.title}</span>
      </div>
      <p className="mt-1 text-xs text-[var(--ctp-subtext0)]">
        {formatCount(module.chars)} chars - {module.lines} linhas
      </p>
    </div>
  );
}

// ── SourceList ────────────────────────────────────────────────────────────────

function SourceList({ sources }: { sources: SearchResult[] }) {
  return (
    <div className="mt-5 flex flex-wrap gap-2">
      {sources.map((source, index) => (
        <a
          key={`${source.url}-${index}`}
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className="max-w-full rounded-full border border-white/10 bg-white/[0.045] px-3 py-1.5 text-xs text-[var(--ctp-subtext0)] transition hover:border-[var(--ctp-blue)]/40 hover:text-[var(--ctp-text)]"
          title={source.title}
        >
          [{index + 1}] {source.displayUrl}
        </a>
      ))}
    </div>
  );
}

// ── Markdown ──────────────────────────────────────────────────────────────────

const markdownComponents = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => <pre>{children}</pre>,
  code: ({ children }: { children?: React.ReactNode }) => (
    <code>{children}</code>
  ),
};

// ── Stream ────────────────────────────────────────────────────────────────────

async function readStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: StreamEvent) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const data = part
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.replace(/^data:\s*/, ""))
        .join("");

      if (!data) continue;
      onEvent(JSON.parse(data) as StreamEvent);
    }
  }
}

// ── Message helpers ───────────────────────────────────────────────────────────

function toApiMessage(message: ChatMessage) {
  return {
    role: message.role,
    content: buildApiContent(message),
  };
}

function buildApiContent(message: ChatMessage): string {
  if (!message.modules?.length) return message.content;

  const moduleText = message.modules
    .map(
      (module, index) =>
        `<module index="${index + 1}" title="${escapeAttribute(module.title)}">\n${module.content}\n</module>`,
    )
    .join("\n\n");

  return `${message.content}\n\nAttached context modules:\n${moduleText}`;
}

function makeTextModule(content: string, index: number): TextModule {
  const clean = content.replace(/\r\n/g, "\n").trim();
  const firstLine = clean.split("\n").find((line) => line.trim().length > 0);
  const title = firstLine
    ? firstLine.trim().slice(0, 72)
    : `Texto colado ${index}`;

  return {
    id: createId(),
    title,
    content: clean,
    chars: clean.length,
    lines: clean.split("\n").length,
    preview: clean.replace(/\s+/g, " ").slice(0, 190),
  };
}

function isLargePaste(value: string): boolean {
  if (!value.trim()) return false;
  return (
    value.length >= PASTE_MODULE_THRESHOLD ||
    value.split(/\r\n|\r|\n/).length >= 22
  );
}

// ── Artifact extraction ───────────────────────────────────────────────────────

const ARTIFACT_RE =
  /<deepbox-artifact\s+type="([^"]+)"\s+title="([^"]+)"(?:\s+language="([^"]*)")?\s*>([\s\S]*?)<\/deepbox-artifact>/g;

function extractArtifacts(content: string): {
  display: string;
  artifacts: Artifact[];
} {
  const artifacts: Artifact[] = [];
  const display = content.replace(
    ARTIFACT_RE,
    (_match, type, title, language, body: string) => {
      artifacts.push({
        type: (["html", "svg", "code", "markdown"].includes(type)
          ? type
          : "markdown") as Artifact["type"],
        title,
        language: language || undefined,
        content: body.trim(),
      });
      return "";
    },
  );
  return { display: display.trim(), artifacts };
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("pt-BR").format(value);
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;");
}

// ── Storage ───────────────────────────────────────────────────────────────────

function readSavedProjects(): Project[] {
  if (typeof window === "undefined") return [createDefaultProject()];

  try {
    const saved = window.localStorage.getItem(PROJECTS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Project[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(normalizeProject);
      }
    }

    const legacyMessages = readLegacyMessages();
    return [createDefaultProject(legacyMessages)];
  } catch {
    window.localStorage.removeItem(PROJECTS_KEY);
    return [createDefaultProject()];
  }
}

function readSavedActiveProjectId(): string {
  if (typeof window === "undefined") return DEFAULT_PROJECT_ID;
  return (
    window.localStorage.getItem(ACTIVE_PROJECT_KEY) ?? DEFAULT_PROJECT_ID
  );
}

function createDefaultProject(messages: ChatMessage[] = []): Project {
  return {
    id: DEFAULT_PROJECT_ID,
    type: "project",
    name: "Pessoal",
    description: "",
    instructions: "",
    memoryModules: [],
    messages,
    modeConfig: { ...DEFAULT_MODE_CONFIG },
  };
}

function normalizeProject(project: Partial<Project>): Project {
  const hasCustomization =
    (typeof project.instructions === "string" && project.instructions.trim()) ||
    (Array.isArray(project.memoryModules) && project.memoryModules.length > 0);
  return {
    id: typeof project.id === "string" ? project.id : createId(),
    type:
      project.type === "chat" || project.type === "project"
        ? project.type
        : hasCustomization
          ? "project"
          : "project",
    name: typeof project.name === "string" ? project.name : "Projeto",
    description:
      typeof project.description === "string" ? project.description : "",
    instructions:
      typeof project.instructions === "string" ? project.instructions : "",
    memoryModules: Array.isArray(project.memoryModules)
      ? project.memoryModules
      : [],
    messages: Array.isArray(project.messages) ? project.messages : [],
    modeConfig:
      project.modeConfig &&
      typeof project.modeConfig.thinking === "string" &&
      typeof project.modeConfig.search === "string"
        ? project.modeConfig
        : { ...DEFAULT_MODE_CONFIG },
  };
}

function readLegacyMessages(): ChatMessage[] {
  try {
    const saved = window.localStorage.getItem("deepbox.messages");
    if (!saved) return [];
    const parsed = JSON.parse(saved) as ChatMessage[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
