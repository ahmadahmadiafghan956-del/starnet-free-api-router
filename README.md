# StarNet Free API Router

Private fallback router for StarNet or any client that can call an OpenAI-compatible Chat Completions endpoint.

## What it does

It tries providers in this order by default:

1. Groq
2. Google Gemini
3. Mistral
4. OpenRouter

If one provider fails because of a rate limit, exhausted quota, temporary outage, or missing key, the router tries the next provider.

## Security

- Real API keys are never stored in this repository.
- Put keys only in your hosting provider's environment variables or a local `.env` file.
- `.env` is ignored by Git.
- If an API key has ever been posted publicly or shared in chat, revoke it and create a new one.

## Setup

1. Clone the repository.
2. Run:

```bash
npm install
cp .env.example .env
```

3. Add provider keys to `.env` locally, or to the hosting provider's private environment settings.
4. Start:

```bash
npm start
```

## Endpoint

Health:

```http
GET /health
```

Chat:

```http
POST /v1/chat/completions
```

Example request:

```json
{
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "temperature": 0.7
}
```

The response includes `router_provider` so you can see which provider answered.

## StarNet connection

Set StarNet's OpenAI-compatible base URL to the deployed router URL and use the chat completions endpoint `/v1/chat/completions` if StarNet asks for the full path. Use any non-empty local label for the model if the UI requires one; the router selects each provider's configured default model unless the request supplies a model.

## Change provider order

Set the hosting environment variable:

```text
PROVIDER_ORDER=groq,gemini,mistral,openrouter
```

You can remove providers that you do not want to use.

This project does not bypass provider limits. It moves to the next provider when one cannot serve the request.
