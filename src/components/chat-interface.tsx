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
  Brain,
  Check,
  Copy,
  FileText,
  Gauge,
  LibraryBig,
  Plus,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  CHAT_MODES,
  DEFAULT_CHAT_MODE,
  getChatMode,
  type ChatModeId,
} from "@/lib/chat-config";
import type { SearchResult } from "@/lib/search";

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
  name: string;
  instructions: string;
  memoryModules: TextModule[];
  messages: ChatMessage[];
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
const DEFAULT_PROJECT_ID = "default-project";

const modeIcons = {
  instant: Zap,
  think: Brain,
  max: Gauge,
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
  const [activeProjectId, setActiveProjectId] = useState(
    readSavedActiveProjectId,
  );
  const [input, setInput] = useState("");
  const [modeId, setModeId] = useState<ChatModeId>(DEFAULT_CHAT_MODE);
  const [modules, setModules] = useState<TextModule[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState("");
  const [abortController, setAbortController] =
    useState<AbortController | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeMode = useMemo(() => getChatMode(modeId), [modeId]);
  const activeProject = useMemo(
    () =>
      projects.find((project) => project.id === activeProjectId) ?? projects[0],
    [activeProjectId, projects],
  );
  const messages = activeProject.messages;
  const projectMemoryModules = activeProject.memoryModules;

  useEffect(() => {
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  }, [projects]);

  useEffect(() => {
    window.localStorage.setItem(ACTIVE_PROJECT_KEY, activeProjectId);
  }, [activeProjectId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, status]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [input]);

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
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      mode: activeMode.label,
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: modeId,
          messages: nextMessages.map(toApiMessage),
          project: {
            name: activeProject.name,
            instructions: activeProject.instructions,
            modules: activeProject.memoryModules.map((module) => ({
              title: module.title,
              content: module.content,
            })),
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const message = await response.text();
        throw new Error(message || "Falha ao chamar o backend.");
      }

      await readStream(response.body, (eventPayload) => {
        if (eventPayload.type === "status") {
          setStatus(eventPayload.message);
          return;
        }

        if (eventPayload.type === "sources") {
          patchAssistant(projectId, assistantId, {
            sources: eventPayload.sources,
          });
          return;
        }

        if (eventPayload.type === "reasoning") {
          appendAssistant(
            projectId,
            assistantId,
            "reasoning",
            eventPayload.delta,
          );
          setStatus("Pensando...");
          return;
        }

        if (eventPayload.type === "token") {
          appendAssistant(projectId, assistantId, "content", eventPayload.delta);
          setStatus("");
          return;
        }

        if (eventPayload.type === "error") {
          patchAssistant(projectId, assistantId, {
            error: eventPayload.message,
          });
          setStatus("");
          return;
        }

        if (eventPayload.type === "done") {
          setStatus("");
        }
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        patchAssistant(projectId, assistantId, {
          error: "Resposta interrompida.",
        });
      } else {
        patchAssistant(projectId, assistantId, {
          error:
            error instanceof Error
              ? error.message
              : "Falha inesperada ao enviar.",
        });
      }
    } finally {
      setIsStreaming(false);
      setAbortController(null);
      setStatus("");
      textareaRef.current?.focus();
    }
  }

  function updateProject(projectId: string, updater: (project: Project) => Project) {
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId ? updater(project) : project,
      ),
    );
  }

  function setProjectMessages(
    projectId: string,
    nextMessages:
      | ChatMessage[]
      | ((currentMessages: ChatMessage[]) => ChatMessage[]),
  ) {
    updateProject(projectId, (project) => ({
      ...project,
      messages:
        typeof nextMessages === "function"
          ? nextMessages(project.messages)
          : nextMessages,
    }));
  }

  function patchAssistant(
    projectId: string,
    id: string,
    patch: Partial<ChatMessage>,
  ) {
    setProjectMessages(projectId, (current) =>
      current.map((message) =>
        message.id === id ? { ...message, ...patch } : message,
      ),
    );
  }

  function appendAssistant(
    projectId: string,
    id: string,
    field: "content" | "reasoning",
    delta: string,
  ) {
    setProjectMessages(projectId, (current) =>
      current.map((message) =>
        message.id === id
          ? { ...message, [field]: `${message[field] ?? ""}${delta}` }
          : message,
      ),
    );
  }

  function stopStreaming() {
    abortController?.abort();
  }

  function clearChat() {
    stopStreaming();
    setProjectMessages(activeProject.id, []);
    setModules([]);
    setStatus("");
  }

  function createProject() {
    const nextProject: Project = {
      id: createId(),
      name: `Projeto ${projects.length + 1}`,
      instructions: "",
      memoryModules: [],
      messages: [],
    };

    setProjects((current) => [...current, nextProject]);
    setActiveProjectId(nextProject.id);
    setModules([]);
    setInput("");
  }

  function pinModuleToProject(module: TextModule) {
    updateProject(activeProject.id, (project) => ({
      ...project,
      memoryModules: [...project.memoryModules, module].slice(-MAX_MODULES),
    }));
    setModules((current) => current.filter((item) => item.id !== module.id));
    setStatus("Modulo salvo no projeto.");
  }

  function removeProjectModule(moduleId: string) {
    updateProject(activeProject.id, (project) => ({
      ...project,
      memoryModules: project.memoryModules.filter(
        (module) => module.id !== moduleId,
      ),
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

  const canSubmit =
    (input.trim().length > 0 || modules.length > 0) && !isStreaming;

  return (
    <div className="flex min-h-dvh overflow-hidden bg-[var(--app-bg)] text-[var(--ctp-text)]">
      <aside className="hidden w-[284px] shrink-0 flex-col border-r border-white/10 bg-[var(--sidebar-bg)] px-3 py-4 backdrop-blur-2xl lg:flex">
        <div className="flex items-center justify-between px-2">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-[12px] bg-[linear-gradient(135deg,var(--ctp-mauve),var(--ctp-teal))] text-[var(--ctp-crust)] shadow-[0_12px_35px_rgba(203,166,247,0.24)]">
              <Sparkles size={18} strokeWidth={2.4} />
            </div>
            <div>
              <p className="font-serif text-xl leading-none tracking-normal text-[var(--ctp-text)]">
                Deepbox
              </p>
              <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-[var(--ctp-subtext0)]">
                DeepSeek V4
              </p>
            </div>
          </div>
          <button
            type="button"
            className="icon-button"
            title="Novo projeto"
            aria-label="Novo projeto"
            onClick={createProject}
          >
            <Plus size={17} />
          </button>
        </div>

        <section className="mt-7 space-y-2">
          <div className="flex items-center justify-between px-1">
            <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--ctp-overlay1)]">
              Projetos
            </p>
            <button
              type="button"
              className="grid size-7 place-items-center rounded-full text-[var(--ctp-overlay2)] transition hover:bg-white/10 hover:text-[var(--ctp-text)]"
              title="Novo projeto"
              aria-label="Novo projeto"
              onClick={createProject}
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`project-row ${
                  project.id === activeProject.id ? "project-row-active" : ""
                }`}
                title={project.name}
                onClick={() => setActiveProjectId(project.id)}
              >
                <LibraryBig size={14} />
                <span className="truncate">{project.name}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="mt-5 rounded-[18px] border border-white/10 bg-white/[0.035] p-3">
          <input
            value={activeProject.name}
            onChange={(event) =>
              updateProject(activeProject.id, (project) => ({
                ...project,
                name: event.target.value,
              }))
            }
            className="w-full rounded-[12px] border border-white/10 bg-black/10 px-3 py-2 text-sm font-medium text-[var(--ctp-text)] outline-none transition focus:border-[var(--ctp-mauve)]/50"
            aria-label="Nome do projeto"
          />
          <textarea
            value={activeProject.instructions}
            onChange={(event) =>
              updateProject(activeProject.id, (project) => ({
                ...project,
                instructions: event.target.value,
              }))
            }
            rows={4}
            placeholder="Instrucoes do projeto"
            className="mt-2 w-full resize-none rounded-[12px] border border-white/10 bg-black/10 px-3 py-2 text-sm leading-5 text-[var(--ctp-subtext1)] outline-none transition placeholder:text-[var(--ctp-overlay1)] focus:border-[var(--ctp-mauve)]/50"
          />
          {projectMemoryModules.length > 0 ? (
            <div className="mt-2 space-y-1.5">
              {projectMemoryModules.map((module) => (
                <ProjectMemoryRow
                  key={module.id}
                  module={module}
                  onRemove={() => removeProjectModule(module.id)}
                />
              ))}
            </div>
          ) : null}
        </section>

        <nav className="mt-5 space-y-2">
          {CHAT_MODES.map((mode) => {
            const Icon = modeIcons[mode.id as keyof typeof modeIcons] ?? Sparkles;
            const active = mode.id === modeId;
            return (
              <button
                key={mode.id}
                type="button"
                title={mode.description}
                onClick={() => setModeId(mode.id as ChatModeId)}
                className={`mode-row ${active ? "mode-row-active" : ""}`}
              >
                <Icon size={16} />
                <span>{mode.label}</span>
                <span className="ml-auto text-[10px] uppercase tracking-[0.16em] text-[var(--ctp-overlay1)]">
                  {mode.model.includes("flash") ? "Flash" : "Pro"}
                </span>
              </button>
            );
          })}
        </nav>

        <div className="mt-auto space-y-3 px-2 text-xs leading-5 text-[var(--ctp-subtext0)]">
          <div className="rounded-[14px] border border-white/10 bg-white/[0.035] p-3">
            <p className="font-medium text-[var(--ctp-text)]">Contexto</p>
            <p className="mt-1">
              {messages.length} mensagens - {projectMemoryModules.length} mem.
            </p>
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 bg-[rgba(30,30,46,0.62)] px-4 backdrop-blur-2xl sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-9 place-items-center rounded-[12px] border border-white/10 bg-white/[0.05] lg:hidden">
              <Sparkles size={17} />
            </div>
            <div className="min-w-0">
              <p className="truncate font-serif text-lg leading-tight tracking-normal">
                {activeProject.name}
              </p>
              <p className="truncate text-xs text-[var(--ctp-subtext0)]">
                {activeMode.label} - {activeMode.model}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="icon-button lg:hidden"
              title="Novo projeto"
              aria-label="Novo projeto"
              onClick={createProject}
            >
              <Plus size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="Limpar"
              aria-label="Limpar"
              onClick={clearChat}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </header>

        <section className="relative flex min-h-0 flex-1 flex-col">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_22%_8%,rgba(137,180,250,0.12),transparent_28%),radial-gradient(circle_at_72%_4%,rgba(148,226,213,0.10),transparent_26%)]" />
          <div className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-8 sm:px-6">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-7">
              {messages.length === 0 ? (
                <EmptyState onPickPrompt={setInput} />
              ) : (
                messages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    copied={copiedId === message.id}
                    onCopy={() => void copyMessage(message)}
                  />
                ))
              )}
              {status ? (
                <div className="message-enter flex items-center gap-3 pl-1 text-sm text-[var(--ctp-subtext0)]">
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
              className="mx-auto w-full max-w-4xl rounded-[26px] border border-white/12 bg-[rgba(24,24,37,0.82)] p-2 shadow-[0_24px_70px_rgba(0,0,0,0.35)] backdrop-blur-2xl"
            >
              {modules.length > 0 ? (
                <div className="grid gap-2 p-2 sm:grid-cols-2">
                  {modules.map((module) => (
                    <TextModuleChip
                      key={module.id}
                      module={module}
                      onRemove={() =>
                        setModules((current) =>
                          current.filter((item) => item.id !== module.id),
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
                className="max-h-[220px] min-h-16 w-full resize-none bg-transparent px-4 py-3 font-serif text-[18px] leading-8 text-[var(--ctp-text)] outline-none placeholder:text-[var(--ctp-overlay1)]"
              />

              <div className="flex flex-col gap-3 border-t border-white/10 px-2 pb-1 pt-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap gap-1.5">
                  {CHAT_MODES.map((mode) => {
                    const Icon =
                      modeIcons[mode.id as keyof typeof modeIcons] ?? Sparkles;
                    const active = mode.id === modeId;
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        title={mode.description}
                        onClick={() => setModeId(mode.id as ChatModeId)}
                        className={`segmented-button ${
                          active ? "segmented-button-active" : ""
                        }`}
                      >
                        <Icon size={14} />
                        <span>{mode.shortLabel}</span>
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
    </div>
  );
}

function EmptyState({
  onPickPrompt,
}: {
  onPickPrompt: (prompt: string) => void;
}) {
  return (
    <div className="mx-auto flex min-h-[42vh] w-full max-w-2xl flex-col justify-center">
      <p className="font-serif text-4xl leading-tight tracking-normal text-[var(--ctp-text)] sm:text-5xl">
        O que vamos pensar hoje?
      </p>
      <div className="mt-7 flex flex-wrap gap-2">
        {starterPrompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="rounded-full border border-white/10 bg-white/[0.045] px-4 py-2 text-left text-sm text-[var(--ctp-subtext0)] transition hover:border-[var(--ctp-lavender)]/40 hover:bg-white/[0.075] hover:text-[var(--ctp-text)]"
            onClick={() => onPickPrompt(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  copied,
  onCopy,
}: {
  message: ChatMessage;
  copied: boolean;
  onCopy: () => void;
}) {
  const isUser = message.role === "user";

  return (
    <article
      className={`message-enter group flex gap-4 ${
        isUser ? "justify-end" : "justify-start"
      }`}
    >
      {!isUser ? (
        <div className="mt-1 grid size-8 shrink-0 place-items-center rounded-[11px] bg-[linear-gradient(135deg,var(--ctp-mauve),var(--ctp-blue))] text-[var(--ctp-crust)] shadow-[0_14px_35px_rgba(137,180,250,0.18)]">
          <Sparkles size={16} />
        </div>
      ) : null}

      <div
        className={`min-w-0 ${
          isUser
            ? "max-w-[min(760px,92%)] rounded-[22px] border border-white/10 bg-[rgba(49,50,68,0.78)] px-5 py-4 shadow-[0_14px_50px_rgba(0,0,0,0.22)]"
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
          <details className="mb-4 rounded-[16px] border border-[var(--ctp-mauve)]/20 bg-[var(--ctp-surface0)]/40 p-3 text-sm text-[var(--ctp-subtext0)]">
            <summary className="cursor-pointer select-none font-medium text-[var(--ctp-mauve)]">
              Raciocinio
            </summary>
            <p className="mt-3 whitespace-pre-wrap font-serif leading-7">
              {message.reasoning}
            </p>
          </details>
        ) : null}

        {message.content ? (
          <div
            className={`markdown-body font-serif ${
              isUser ? "text-[17px]" : "text-[18px]"
            }`}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {message.content}
            </ReactMarkdown>
          </div>
        ) : message.role === "assistant" && !message.error ? (
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

        {message.sources?.length ? <SourceList sources={message.sources} /> : null}

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

function TextModuleChip({
  module,
  onRemove,
  onPin,
}: {
  module: TextModule;
  onRemove: () => void;
  onPin: () => void;
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
        <button
          type="button"
          className="grid size-7 place-items-center rounded-full text-[var(--ctp-teal)] transition hover:bg-white/10 hover:text-[var(--ctp-text)]"
          title="Salvar no projeto"
          aria-label="Salvar no projeto"
          onClick={onPin}
        >
          <LibraryBig size={14} />
        </button>
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

const markdownComponents = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => <pre>{children}</pre>,
  code: ({ children }: { children?: React.ReactNode }) => <code>{children}</code>,
};

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

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("pt-BR").format(value);
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;");
}

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
  return window.localStorage.getItem(ACTIVE_PROJECT_KEY) ?? DEFAULT_PROJECT_ID;
}

function createDefaultProject(messages: ChatMessage[] = []): Project {
  return {
    id: DEFAULT_PROJECT_ID,
    name: "Pessoal",
    instructions: "",
    memoryModules: [],
    messages,
  };
}

function normalizeProject(project: Partial<Project>): Project {
  return {
    id: typeof project.id === "string" ? project.id : createId(),
    name: typeof project.name === "string" ? project.name : "Projeto",
    instructions:
      typeof project.instructions === "string" ? project.instructions : "",
    memoryModules: Array.isArray(project.memoryModules)
      ? project.memoryModules
      : [],
    messages: Array.isArray(project.messages) ? project.messages : [],
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
