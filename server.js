import { timingSafeEqual } from "node:crypto";
import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const order = (process.env.PROVIDER_ORDER || "groq,cloudflare,gemini,mistral,openrouter,github")
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
    copy.messages = copy.messages.map(message => {
      const clean = {
        role: message?.role || "user",
        content: messageText(message?.content)
      };
      if (message?.name != null) clean.name = message.name;
      if (message?.tool_call_id != null) clean.tool_call_id = message.tool_call_id;
      if (Array.isArray(message?.tool_calls)) clean.tool_calls = message.tool_calls;
      if (clean.role === "assistant" && clean.tool_calls?.length && !clean.content) clean.content = null;
      if (clean.role === "assistant" && !clean.tool_calls?.length && !clean.content) clean.content = " ";
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

function lastUserText(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messageText(messages[i]?.content);
  }
  return "";
}

function explicitToolIntent(body = {}) {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return false;
  if (body.tool_choice === "required") return true;
  const text = lastUserText(body).toLowerCase();
  return /\b(use|call|invoke|run|execute|actually call|use one available)\b[\s\S]{0,80}\b(tool|function)\b/i.test(text) ||
    /(ابزار|تول).{0,80}(استفاده|اجرا|صدا|کال)|(استفاده|اجرا).{0,80}(ابزار|تول)/i.test(text);
}

function selectRelevantTools(body = {}, limit = 12) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length <= limit) return tools;

  const query = lastUserText(body).toLowerCase();
  const words = new Set((query.match(/[a-z0-9_\-]{3,}|[\u0600-\u06ff]{3,}/gi) || [])
    .map(x => x.toLowerCase()));

  const ranked = tools.map((tool, index) => {
    const name = String(tool?.function?.name || "").toLowerCase();
    const description = String(tool?.function?.description || "").toLowerCase();
    const haystack = name + " " + description;
    let score = 0;
    for (const word of words) {
      if (name.includes(word)) score += 6;
      else if (description.includes(word)) score += 2;
    }
    return { tool, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);

  return ranked.slice(0, limit).map(x => x.tool);
}

function compactToolsForProvider(body = {}, limit = 12) {
  const copy = { ...body };
  if (Array.isArray(copy.tools) && copy.tools.length > limit) {
    copy.tools = selectRelevantTools(copy, limit);
  }
  return copy;
}

function attemptedMissingTool(error) {
  const text = String(error?.message || error || "");
  const patterns = [
    /attempted to call tool ['"`]([^'"`]+)['"`]/i,
    /tool ['"`]([^'"`]+)['"`] which was not in request\.tools/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function forceToolIntoBody(originalBody = {}, routedBody = {}, toolName, limit = 12) {
  const allTools = Array.isArray(originalBody.tools) ? originalBody.tools : [];
  const missingTool = allTools.find(t => t?.function?.name === toolName);
  if (!missingTool) return null;

  const routedTools = Array.isArray(routedBody.tools) ? [...routedBody.tools] : [];
  if (routedTools.some(t => t?.function?.name === toolName)) return null;

  const safeLimit = Math.max(1, Number(limit) || 12);
  const nextTools = routedTools.slice(0, Math.max(0, safeLimit - 1));
  nextTools.push(missingTool);
  return { ...routedBody, tools: nextTools };
}

function geminiSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "string" };
  }

  let type = schema.type;
  if (Array.isArray(type)) type = type.find(x => x !== "null") || "string";
  if (!type) {
    if (schema.properties) type = "object";
    else if (schema.items) type = "array";
    else type = "string";
  }

  const out = { type: String(type).toLowerCase() };
  if (schema.description) out.description = String(schema.description);
  if (Array.isArray(schema.enum) && schema.enum.length) out.enum = schema.enum.map(String);

  if (out.type === "object") {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties || {})) {
      out.properties[key] = geminiSchema(value);
    }
    if (Array.isArray(schema.required)) {
      const valid = schema.required.filter(k => Object.prototype.hasOwnProperty.call(out.properties, k));
      if (valid.length) out.required = valid;
    }
  } else if (out.type === "array") {
    out.items = geminiSchema(schema.items || { type: "string" });
  }

  return out;
}

function trimMessagesForGroq(body = {}) {
  const copy = { ...body };
  const messages = Array.isArray(copy.messages) ? copy.messages : [];
  const maxChars = Math.max(4000, Number(process.env.GROQ_MAX_INPUT_CHARS || 12000));
  let used = 0;
  const kept = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] || {};
    const text = typeof m.content === "string" ? m.content : messageText(m.content);
    const cost = text.length + 100;
    if (kept.length && used + cost > maxChars) continue;
    kept.push({ ...m, content: text });
    used += cost;
    if (used >= maxChars) break;
  }

  copy.messages = kept.reverse();
  return copy;
}

const providerCooldowns = new Map();

function providerCoolingDown(name) {
  const until = providerCooldowns.get(name) || 0;
  if (until <= Date.now()) {
    providerCooldowns.delete(name);
    return false;
  }
  return true;
}

function setProviderCooldown(name, error) {
  const text = String(error?.message || error || "").toLowerCase();
  let ms = 0;
  if (/\b402\b|out of credit|insufficient credit|more credits/.test(text)) ms = 30 * 60 * 1000;
  else if (/\b429\b|quota exceeded|rate limit/.test(text)) {
    const retry = text.match(/retry(?: in| after)?\s*(\d+(?:\.\d+)?)\s*(s|m|h)/i);
    if (retry) {
      const n = Number(retry[1]);
      ms = n * (retry[2].toLowerCase() === "h" ? 3600000 : retry[2].toLowerCase() === "m" ? 60000 : 1000);
    } else {
      ms = 60 * 1000;
    }
  } else if (/\b503\b|unavailable|high demand/.test(text)) ms = 30 * 1000;
  if (ms > 0) providerCooldowns.set(name, Date.now() + Math.min(ms, 24 * 60 * 60 * 1000));
}


const stagedApiProviders = {
  fireworks: { endpoint: "https://api.fireworks.ai/inference/v1", key: "FIREWORKS_API_KEY", model: "FIREWORKS_MODEL" },
  cerebras: { endpoint: "https://api.cerebras.ai/v1", key: "CEREBRAS_API_KEY", model: "CEREBRAS_MODEL", fallback: "gpt-oss-120b" },
  together: { endpoint: "https://api.together.ai/v1", key: "TOGETHER_API_KEY", model: "TOGETHER_MODEL" },
  cohere: { endpoint: "https://api.cohere.ai/compatibility/v1", key: "COHERE_API_KEY", model: "COHERE_MODEL", fallback: "command-a-03-2025" }
};

async function callStagedApiProvider(name, body) {
  const config = stagedApiProviders[name];
  if (!config) throw new Error("Unknown staged provider");
  // A staged provider is not eligible for auto-routing until explicitly added to PROVIDER_ORDER.
  const key = process.env[config.key];
  const model = process.env[config.model] || config.fallback;
  if (!key || !model) throw new Error(name + " is unconfigured");
  const response = await fetch(config.endpoint + "/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ ...compactToolsForProvider({ ...normalizedBody(body), max_tokens: Math.min(256, Number(body?.max_tokens || 256)) }, name === "cohere" ? 4 : 12), model }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const raw = await response.text();
    let reason = "unspecified";
    try {
      const parsed = JSON.parse(raw);
      reason = String(parsed.message || parsed.error?.message || parsed.error || "unspecified");
    } catch {}
    console.warn("[router] " + name + " HTTP " + response.status + " category=" + (/tool|function|schema/i.test(reason) ? "tool_schema" : /message|role|content/i.test(reason) ? "message_format" : "other"));
    throw new Error(name + " HTTP " + response.status);
  }
  return response.json();
}

const providers = {
  async fireworks(body) { return callStagedApiProvider("fireworks", body); },
  async cerebras(body) { return callStagedApiProvider("cerebras", body); },
  async together(body) { return callStagedApiProvider("together", body); },
  async cohere(body) { return callStagedApiProvider("cohere", body); },
  async groq(body) {
    body = compactToolsForProvider(trimMessagesForGroq(normalizedBody(body)), Number(process.env.GROQ_MAX_TOOLS || 12));
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

  async cloudflare(body) {
    body = normalizedBody(body);
    if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN missing");
    if (!process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error("CLOUDFLARE_ACCOUNT_ID missing");

    const model = process.env.CLOUDFLARE_MODEL || "@cf/zai-org/glm-4.7-flash";
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID)}/ai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: body.messages || [],
          ...(body.temperature != null ? { temperature: body.temperature } : {}),
          ...(body.top_p != null ? { top_p: body.top_p } : {}),
          ...(body.max_tokens != null ? { max_tokens: body.max_tokens } : {}),
          ...(body.stop != null ? { stop: body.stop } : {}),
          ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
          ...(body.tool_choice != null ? { tool_choice: body.tool_choice } : {})
        })
      }
    );
    if (!r.ok) throw new Error(`Cloudflare ${r.status}: ${await r.text()}`);
    return r.json();
  },

  async gemini(body) {
    body = normalizedBody(body);
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
    const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";

    // Convert OpenAI-style messages and tools from StarNet to Gemini format.
    const contents = (body.messages || []).map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }]
    }));
    const functionDeclarations = Array.isArray(body.tools)
      ? body.tools
          .filter(t => t?.type === "function" && t?.function?.name)
          .map(t => ({
            name: t.function.name,
            ...(t.function.description ? { description: t.function.description } : {}),
            parameters: geminiSchema(t.function.parameters || { type: "object", properties: {} })
          }))
      : [];

    const requestBody = {
      contents,
      generationConfig: {
        ...(body.temperature != null ? { temperature: body.temperature } : {}),
        ...(body.max_tokens != null ? { maxOutputTokens: body.max_tokens } : {})
      },
      ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
      ...(functionDeclarations.length && body.tool_choice === "required"
        ? { toolConfig: { functionCallingConfig: { mode: "ANY" } } }
        : {})
    };

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      }
    );

    if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p?.text || "").join("");
    const functionCalls = parts.filter(p => p?.functionCall?.name).map((p, index) => ({
      id: `call_gemini_${Date.now()}_${index}`,
      type: "function",
      function: {
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args || {})
      }
    }));

    const message = { role: "assistant", content: text || null };
    if (functionCalls.length) message.tool_calls = functionCalls;

    return {
      id: "gemini-fallback",
      object: "chat.completion",
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: functionCalls.length ? "tool_calls" : "stop"
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

  async github(body) {
    body = normalizedBody(body);
    if (!process.env.GITHUB_MODELS_TOKEN) throw new Error("GITHUB_MODELS_TOKEN missing");
    body = compactToolsForProvider(body, Number(process.env.GITHUB_MAX_TOOLS || 12));
    const r = await fetch("https://models.github.ai/inference/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GITHUB_MODELS_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/vnd.github+json"
      },
      body: JSON.stringify({
        ...body,
        model: process.env.GITHUB_MODELS_MODEL || "openai/gpt-4.1-mini"
      })
    });
    if (!r.ok) throw new Error(`GitHub Models ${r.status}: ${await r.text()}`);
    return r.json();
  },

  async openrouter(body) {
    body = normalizedBody(body);
    const openRouterCap = Math.max(1, Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS || 1024));
    body.max_tokens = Math.min(Number(body.max_tokens || openRouterCap), openRouterCap);
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

app.get("/health/github-models", async (req, res) => {
  if (!process.env.ROUTER_API_KEY) return res.status(503).json({ ok: false, error: "Router authentication is not configured" });
  if (!hasValidRouterKey(req)) return res.status(401).json({ ok: false, error: "Unauthorized" });
  try {
    const result = await providers.github({
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 8,
      stream: false
    });
    const text = String(result?.choices?.[0]?.message?.content || "").trim();
    return res.json({ ok: true, provider: "github", model: result?.model || process.env.GITHUB_MODELS_MODEL || "openai/gpt-4.1-mini", responded: Boolean(text) });
  } catch (err) {
    const safeError = String(err?.message || err)
      .replace(/(key=)[^&\\s]+/gi, "$1[REDACTED]")
      .replace(/(Bearer\\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
      .slice(0, 500);
    return res.status(502).json({ ok: false, provider: "github", error: safeError });
  }
});

app.post("/v1/chat/completions", async (req, res) => {
  if (!process.env.ROUTER_API_KEY) {
    return res.status(503).json({ error: "Router authentication is not configured" });
  }
  if (!hasValidRouterKey(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const errors = [];
  const mustUseTool = explicitToolIntent(req.body || {});
  const requestOrder = mustUseTool
    ? (order.includes("gemini") ? ["gemini", ...order.filter(name => name !== "gemini")] : order)
    : order;

  for (const name of requestOrder) {
    if (providerCoolingDown(name)) {
      errors.push({ provider: name, error: "Temporarily skipped after a recent quota/rate/credit failure" });
      continue;
    }
    const fn = providers[name];
    if (!fn) {
      errors.push({ provider: name, error: "Unknown provider" });
      continue;
    }

    try {
      const wantsStream = req.body?.stream === true;
      const originalToolsIn = Array.isArray(req.body?.tools) ? req.body.tools.length : 0;
      let providerBody = req.body || {};
      if (mustUseTool && originalToolsIn > 0) {
        providerBody = compactToolsForProvider(providerBody, Number(process.env.MAX_ROUTED_TOOLS || 12));
        providerBody = { ...providerBody, tool_choice: "required" };
      }
      const toolsIn = Array.isArray(providerBody?.tools) ? providerBody.tools.length : 0;
      let result;
      try {
        result = await fn(providerBody);
      } catch (firstError) {
        const missingToolName = attemptedMissingTool(firstError);
        const retryBody = missingToolName
          ? forceToolIntoBody(
              req.body || {},
              providerBody,
              missingToolName,
              Number(process.env.MAX_ROUTED_TOOLS || 12)
            )
          : null;

        if (!retryBody) throw firstError;

        console.warn(`[router] provider=${name} retrying once with requested missing tool=${missingToolName}`);
        result = await fn(retryBody);
        providerBody = retryBody;
      }
      const toolCallsOut = Array.isArray(result?.choices?.[0]?.message?.tool_calls)
        ? result.choices[0].message.tool_calls.length
        : 0;
      const returnedText = String(result?.choices?.[0]?.message?.content || "");
      const toolNames = Array.isArray(req.body?.tools)
        ? req.body.tools.map(t => t?.function?.name).filter(Boolean)
        : [];
      const mentionsKnownTool = toolsIn > 0 && toolCallsOut === 0 &&
        toolNames.some(toolName => returnedText.includes(toolName));
      const looksLikeSerializedToolCall = toolsIn > 0 && toolCallsOut === 0 &&
        /<tool_call>|<\/tool_call>|<arg_value>|<\/arg_value>/i.test(returnedText);
      console.log(`[router] provider=${name} success tools_in=${toolsIn}/${originalToolsIn} tool_calls_out=${toolCallsOut} finish=${result?.choices?.[0]?.finish_reason || "unknown"}`);
      if (looksLikeSerializedToolCall || mentionsKnownTool) {
        throw new Error("Provider described/serialized a tool call as text instead of structured tool_calls");
      }
      if (mustUseTool && toolsIn > 0 && toolCallsOut === 0) {
        throw new Error("Explicit tool request returned no structured tool_calls; trying next provider");
      }

      if (wantsStream) {
        const message = result?.choices?.[0]?.message || {};
        const content = message?.content ?? "";
        const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
        const model = result?.model || req.body?.model || "starnet-router";
        const id = result?.id || `chatcmpl-router-${Date.now()}`;
        const finishReason = result?.choices?.[0]?.finish_reason || (toolCalls.length ? "tool_calls" : "stop");

        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");

        const delta = { role: "assistant" };
        if (content !== null && content !== "") delta.content = content;
        if (toolCalls.length) delta.tool_calls = toolCalls;

        const first = {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta,
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
            finish_reason: finishReason
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
      setProviderCooldown(name, err);
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


