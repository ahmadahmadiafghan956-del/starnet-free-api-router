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

function normalizedBody(body = {}) {
  const copy = { ...body };
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
      const result = await fn(req.body || {});
      return res.status(200).json({
        ...result,
        router_provider: name
      });
    } catch (err) {
      errors.push({ provider: name, error: String(err?.message || err).slice(0, 500) });
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
