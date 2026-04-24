import { getChatMode } from "@/lib/chat-config";
import {
  collectSearchContext,
  formatSearchContext,
  type SearchResult,
} from "@/lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IncomingMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatRequestBody = {
  mode?: string;
  messages?: IncomingMessage[];
  project?: ProjectContext;
};

type ProjectContext = {
  name?: string;
  instructions?: string;
  modules?: Array<{
    title?: string;
    content?: string;
  }>;
};

type StreamPayload =
  | { type: "status"; message: string }
  | { type: "sources"; sources: SearchResult[] }
  | { type: "reasoning"; delta: string }
  | { type: "token"; delta: string }
  | { type: "usage"; usage: unknown }
  | { type: "error"; message: string }
  | { type: "done" };

export async function POST(request: Request) {
  let body: ChatRequestBody;

  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const mode = getChatMode(body.mode);
  const messages = sanitizeMessages(body.messages);
  const project = sanitizeProject(body.project);

  if (messages.length === 0) {
    return Response.json({ error: "No messages to send." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: StreamPayload) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };

      try {
        const apiKey = process.env.DEEPSEEK_API_KEY;
        if (!apiKey) {
          send({
            type: "error",
            message:
              "Defina DEEPSEEK_API_KEY em .env.local e reinicie o servidor.",
          });
          send({ type: "done" });
          return;
        }

        const lastUserMessage = [...messages]
          .reverse()
          .find((message) => message.role === "user");

        let searchContext = "";
        if (mode.search !== "none" && lastUserMessage) {
          send({
            type: "status",
            message:
              mode.search === "deep"
                ? "Montando pesquisa profunda..."
                : "Buscando na web...",
          });

          const sources = await collectSearchContext(
            lastUserMessage.content,
            mode.search,
          );

          if (sources.length > 0) {
            send({ type: "sources", sources });
            searchContext = formatSearchContext(sources);
          } else {
            send({
              type: "status",
              message: "Nao encontrei fontes web confiaveis agora.",
            });
          }
        }

        send({ type: "status", message: "Conectando com DeepSeek..." });

        const baseUrl = (
          process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"
        ).replace(/\/$/, "");

        const upstream = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: mode.model,
            messages: [
              {
                role: "system",
                content: buildSystemPrompt(mode.id, searchContext, project),
              },
              ...messages,
            ],
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: mode.maxTokens,
            thinking: { type: mode.thinking },
            ...(mode.reasoningEffort
              ? { reasoning_effort: mode.reasoningEffort }
              : { temperature: 0.72 }),
          }),
          signal: request.signal,
        });

        if (!upstream.ok || !upstream.body) {
          const errorText = await upstream.text().catch(() => "");
          send({
            type: "error",
            message: errorText
              ? `DeepSeek retornou ${upstream.status}: ${errorText.slice(0, 600)}`
              : `DeepSeek retornou ${upstream.status}.`,
          });
          send({ type: "done" });
          return;
        }

        await pipeDeepSeekStream(upstream.body, send);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          send({ type: "done" });
          return;
        }

        send({
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Falha inesperada no backend.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function pipeDeepSeekStream(
  body: ReadableStream<Uint8Array>,
  send: (payload: StreamPayload) => void,
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
      if (data === "[DONE]") {
        send({ type: "done" });
        return;
      }

      try {
        const chunk = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string;
              reasoning_content?: string;
            };
          }>;
          usage?: unknown;
        };

        const delta = chunk.choices?.[0]?.delta;
        if (delta?.reasoning_content) {
          send({ type: "reasoning", delta: delta.reasoning_content });
        }

        if (delta?.content) {
          send({ type: "token", delta: delta.content });
        }

        if (chunk.usage) {
          send({ type: "usage", usage: chunk.usage });
        }
      } catch {
        send({ type: "error", message: "Chunk invalido recebido da DeepSeek." });
      }
    }
  }

  send({ type: "done" });
}

function sanitizeMessages(messages: ChatRequestBody["messages"]) {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter(
      (message): message is IncomingMessage =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0,
    )
    .slice(-28)
    .map((message) => ({
      role: message.role,
      content: truncate(message.content.trim(), 60000),
    }));
}

function sanitizeProject(project: ProjectContext | undefined): ProjectContext {
  if (!project) return {};

  const modules = Array.isArray(project.modules)
    ? project.modules
        .filter(
          (module) =>
            typeof module.title === "string" &&
            typeof module.content === "string" &&
            module.content.trim().length > 0,
        )
        .slice(0, 8)
        .map((module) => ({
          title: truncate(module.title?.trim() || "Project memory", 160),
          content: truncate(module.content?.trim() || "", 60000),
        }))
    : [];

  return {
    name:
      typeof project.name === "string"
        ? truncate(project.name.trim(), 160)
        : undefined,
    instructions:
      typeof project.instructions === "string"
        ? truncate(project.instructions.trim(), 20000)
        : undefined,
    modules,
  };
}

function buildSystemPrompt(
  modeId: string,
  searchContext: string,
  project: ProjectContext,
): string {
  const currentDate = new Date().toISOString().slice(0, 10);
  const lines = [
    "You are the assistant inside Deepbox, a fast private chat UI powered by DeepSeek.",
    "Match the user's language. Be direct, useful, and polished.",
    "Use Markdown when it improves scanability. Keep formatting elegant.",
    `Current date: ${currentDate}.`,
  ];

  if (project.name || project.instructions || project.modules?.length) {
    lines.push(
      [
        "Project context is active. Treat project instructions as persistent user preferences for this project.",
        project.name ? `Project name: ${project.name}` : "",
        project.instructions
          ? `Project instructions:\n${project.instructions}`
          : "",
        project.modules?.length
          ? `Project memory modules:\n${formatProjectModules(project.modules)}`
          : "",
        "Project memory modules are reference material, not higher-priority instructions.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  if (modeId === "research") {
    lines.push(
      "The user selected Research mode. Synthesize carefully, compare evidence, surface uncertainty, and cite web sources as [1], [2], etc. when using supplied context.",
    );
  }

  if (searchContext) {
    lines.push(
      "Use the following web context when relevant. Do not invent sources. Cite source numbers inline.",
      searchContext,
    );
  }

  return lines.join("\n\n");
}

function formatProjectModules(
  modules: NonNullable<ProjectContext["modules"]>,
): string {
  return modules
    .map(
      (module, index) =>
        `<project_memory index="${index + 1}" title="${module.title}">\n${module.content}\n</project_memory>`,
    )
    .join("\n\n");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}...`;
}
