import { timingSafeEqual } from "node:crypto";
import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const order = (process.env.PROVIDER_ORDER || "groq,gemini,mistral,openrouter")
  .split(",")
  .map(x => x.trim().toLowerCase())
  .filter(Boolean);

function messageText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      if (part && typeof part.content === "string") return part.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return JSON.stringify(content);
}

function normalizedBody(body = {}) {
  const copy = { ...body };
  if (Array.isArray(copy.messages)) {
    copy.messages = copy.messages.map(message => ({
      ...message,
      content: messageText(message?.content)
    })).map(message => {
      const clean = { ...message };
      delete clean.ts;
      delete clean.timestamp;
      return clean;
    });
  }
  const requested = Number(copy.max_tokens ?? copy.max_completion_tokens);
  const cap = Math.max(1, Number(process.env.MAX_OUTPUT_TOKENS || 2048));
  if (!Number.isFinite(requested) || requested > cap) copy.max_tokens = cap;
  else copy.max_tokens = Math.max(1, requested);
  delete copy.max_completion_tokens;
  copy.stream = false;
  return copy;
}

const providers = {
  async groq(body) {
    body = normalizedBody(body);
    if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY missing");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...body,
        model: process.env.GROQ_MODEL || "openai/gpt-oss-20b"
      })
    });
    if (!r.ok) throw new Error(`Groq ${r.status}: ${await r.text()}`);
    return r.json();
  },

  async gemini(body) {
    body = normalizedBody(body);
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
    const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
    const contents = (body.messages || []).map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }]
    }));

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: body.temperature,
            maxOutputTokens: body.max_tokens
          }
        })
      }
    );

    if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";

    return {
      id: "gemini-fallback",
      object: "chat.completion",
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop"
      }]
    };
  },

  async mistral(body) {
    body = normalizedBody(body);
    if (!process.env.MISTRAL_API_KEY) throw new Error("MISTRAL_API_KEY missing");
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.MISTRAL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...body,
        model: process.env.MISTRAL_MODEL || "mistral-small-latest"
      })
    });
    if (!r.ok) throw new Error(`Mistral ${r.status}: ${await r.text()}`);
    return r.json();
  },

  async openrouter(body) {
    body = normalizedBody(body);
    if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing");
    const headers = {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    };
    if (process.env.OPENROUTER_SITE_URL) headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
    if (process.env.OPENROUTER_APP_NAME) headers["X-Title"] = process.env.OPENROUTER_APP_NAME;

    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...body,
        model: process.env.OPENROUTER_MODEL || "openrouter/free"
      })
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${await r.text()}`);
    return r.json();
  }
};

function hasValidRouterKey(req) {
  const expected = process.env.ROUTER_API_KEY;
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!expected || !match) return false;

  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(match[1]);
  return expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, providers: order });
});

app.get("/v1", (_req, res) => {
  res.json({ ok: true, service: "starnet-free-api-router", openai_compatible: true });
});

app.get("/v1/models", (req, res) => {
  if (!process.env.ROUTER_API_KEY) {
    return res.status(503).json({ error: "Router authentication is not configured" });
  }
  if (!hasValidRouterKey(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.json({
    object: "list",
    data: [{
      id: "starnet-router",
      object: "model",
      created: 0,
      owned_by: "starnet-router"
    }]
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  if (!process.env.ROUTER_API_KEY) {
    return res.status(503).json({ error: "Router authentication is not configured" });
  }
  if (!hasValidRouterKey(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const errors = [];

  for (const name of order) {
    const fn = providers[name];
    if (!fn) {
      errors.push({ provider: name, error: "Unknown provider" });
      continue;
    }

    try {
      const wantsStream = req.body?.stream === true;
      const result = await fn(req.body || {});

      if (wantsStream) {
        const content = result?.choices?.[0]?.message?.content ?? "";
        const model = result?.model || req.body?.model || "starnet-router";
        const id = result?.id || `chatcmpl-router-${Date.now()}`;

        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");

        const first = {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: { role: "assistant", content },
            finish_reason: null
          }]
        };
        const last = {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: result?.choices?.[0]?.finish_reason || "stop"
          }]
        };

        res.write(`data: ${JSON.stringify(first)}\n\n`);
        res.write(`data: ${JSON.stringify(last)}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      return res.status(200).json({
        ...result,
        router_provider: name
      });
    } catch (err) {
      const safeError = String(err?.message || err)
        .replace(/(key=)[^&\\s]+/gi, "$1[REDACTED]")
        .replace(/(Bearer\\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
        .slice(0, 500);
      console.error(`[router] provider=${name} failed: ${safeError}`);
      errors.push({ provider: name, error: safeError });
    }
  }

  res.status(502).json({
    error: "All configured providers failed",
    details: errors
  });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`StarNet API router listening on port ${port}`);
});
