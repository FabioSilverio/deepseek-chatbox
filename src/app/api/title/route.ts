export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      userMessage?: string;
      assistantSnippet?: string;
    };

    const userMessage = typeof body.userMessage === "string" ? body.userMessage.trim() : "";
    const assistantSnippet =
      typeof body.assistantSnippet === "string" ? body.assistantSnippet.trim() : "";

    if (!userMessage) return Response.json({ title: null });

    const apiKey =
      request.headers.get("X-Deepseek-Key") ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return Response.json({ title: null });

    const baseUrl = (
      process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"
    ).replace(/\/$/, "");

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [
          {
            role: "system",
            content:
              "You generate ultra-short conversation titles. Rules: same language as the user, 3–6 words max, no quotes, no period at the end, capitalize first word only. Output ONLY the title text.",
          },
          {
            role: "user",
            content: `User: ${userMessage.slice(0, 400)}\nAssistant: ${assistantSnippet.slice(0, 400)}\n\nTitle:`,
          },
        ],
        max_tokens: 24,
        temperature: 0.35,
        thinking: { type: "disabled" },
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return Response.json({ title: null });

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
    const title = raw.replace(/^["']|["']$/g, "").replace(/[.!?]+$/, "").trim();

    return Response.json({ title: title || null });
  } catch {
    return Response.json({ title: null });
  }
}
