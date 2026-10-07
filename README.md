# StarNet Free API Router

Private fallback router for StarNet or any client that can call an OpenAI-compatible Chat Completions endpoint.

## What it does

It tries providers in this order by default:

1. Groq
2. Google Gemini
3. Mistral
4. OpenRouter

If one provider fails because of a rate limit, exhausted quota, temporary outage, or missing key, the router tries the next provider. Each provider uses its own configured default model, so the model name sent by the client does not break fallback between providers.

## Security

- Real provider API keys are never stored in this repository.
- Put provider keys only in your hosting provider's private environment settings or a local .env file.
- .env is ignored by Git.
- The chat endpoint requires a router key in the HTTP Authorization: Bearer ... header. Keep that key private and use it as StarNet's API key.
- The health endpoint is public and does not reveal secrets.
- If an API key has ever been posted publicly or shared in chat, revoke it and create a new one.

## Setup

1. Clone the repository.
2. Run:

    npm install
    cp .env.example .env

3. Add provider keys and a private ROUTER_API_KEY to .env, or add them in the hosting provider's private environment settings.
4. Start:

    npm start

## Endpoints

Health:

    GET /health

Chat:

    POST /v1/chat/completions
    Authorization: Bearer <ROUTER_API_KEY>

Example request:

    {
      "messages": [
        {"role": "user", "content": "Hello"}
      ],
      "temperature": 0.7
    }

The response includes router_provider so you can see which provider answered.

## StarNet connection

Set StarNet's provider type to OpenAI-compatible (or OpenAI), set its base URL to the deployed router URL, and enter the same private router key as the API key. If StarNet asks for the full endpoint path, use /v1/chat/completions. Use any non-empty local model label if required; the router selects its configured model for each provider.

## Provider configuration

Set this environment variable:

    PROVIDER_ORDER=groq,gemini,mistral,openrouter

The provider keys and model defaults are listed in .env.example. Remove providers from PROVIDER_ORDER if you do not want to use them.

This project does not bypass provider limits. It moves to the next provider when one cannot serve the request.
