# StarNet Free API Router

Private fallback router for StarNet or any client that can call an OpenAI-compatible Chat Completions endpoint.

## What it does

It tries providers in this order by default:

1. Groq
2. Google Gemini
3. OpenRouter

If one provider fails because of a rate limit, exhausted free quota, temporary outage, or missing key, the router tries the next provider.

## Security

- Real API keys are **never** stored in this repository.
- Put keys only in a local or hosted `.env` file.
- `.env` is ignored by Git.
- If an API key has ever been posted publicly or shared in chat, revoke it and create a new one.

## Setup

1. Clone the repository.
2. Run:

```bash
npm install
cp .env.example .env
```

3. Put your own keys into `.env`.
4. Start:

```bash
npm start
```

## Endpoint

Health:

```
GET /health
```

Chat:

```
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

If StarNet supports a custom OpenAI-compatible base URL, point it to the deployed router URL and use:

```
/v1/chat/completions
```

This project does **not** bypass provider limits. It only moves to the next provider when one legitimately cannot serve the request.

## Change provider order

Set:

```
PROVIDER_ORDER=groq,gemini,openrouter
```

You can remove any provider you do not want.
