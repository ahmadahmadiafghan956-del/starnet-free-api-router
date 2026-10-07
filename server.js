import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const order = (process.env.PROVIDER_ORDER || "groq,gemini,openrouter")
  .split(",")
  .map(x => x.trim().toLowerCase())
  .filter(Boolean);

const providers = {
  async groq(body) {
    if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY missing");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...body,
        model: body.model || process.env.GROQ_MODEL || "llama-3.3-70b-versatile"
      })
    });
    if (!r.ok) throw new Error(`Groq ${r.status}: ${await r.text()}`);
    return r.json();
  },

  async gemini(body) {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
    const model = body.model || process.env.GEMINI_MODEL || "gemini-2.0-flash";
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

  async openrouter(body) {
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
        model: body.model || process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free"
      })
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${await r.text()}`);
    return r.json();
  }
};

app.get("/health", (_req, res) => {
  res.json({ ok: true, providers: order });
});

app.post("/v1/chat/completions", async (req, res) => {
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
