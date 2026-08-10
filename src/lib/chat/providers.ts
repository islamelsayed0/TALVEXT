import 'server-only'

import { logInfo, type LogDetail } from '@/lib/log'

import type { PlatformProvider } from '@/lib/billing/managed-ai'
import type { AiProvider } from '@/lib/db/types'
import { AI_PROVIDER_LABELS } from './providers-meta'

/**
 * The provider abstraction (Task 5). One shape in, one shape out, across
 * Anthropic, OpenAI, and Google. Every call happens server side with the org's
 * own key (BYOK); the key never reaches the browser and is decrypted only in
 * request scope by the caller before it gets here.
 *
 * SSRF by configuration, deliberately closed: the provider base URLs below are
 * CONSTANTS and must never become user configurable. The monitor SSRF screen
 * (docs/DECISIONS.md) guards user supplied URLs at check time; there is no user
 * supplied URL here at all, because a tenant choosing where their AI request is
 * sent would be SSRF by configuration. The provider is chosen from a fixed
 * three value set; the endpoint is derived from that, never from input.
 *
 * Logging (ruling 4): NOTHING key shaped is ever logged. logCall emits provider,
 * model, status, latency, and token counts only, never the key, the request or
 * response headers, or the request or response bodies. On a failed call the
 * error carries a plain language remediation derived from the status code
 * alone; the response body is never read into a log or an error.
 *
 * ONE attempt per call, no retries here or in any caller (the platform key
 * resilience rule, RUNBOOK section 8): on the managed path a retry would
 * multiply spend on the operator's key against the very limit that may be
 * refusing it, and on BYOK it would multiply the customer's. A failure is
 * reported honestly instead.
 */

const PROVIDER_BASE_URLS: Record<AiProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  google: 'https://generativelanguage.googleapis.com',
}

/**
 * Default models, hardcoded this task (ruling 7): support chat, so cheap is
 * correct and it is the customer's money. Per org model choice is future work
 * (docs/future_update.md). The cheapest current small tier per provider.
 */
export const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash-lite',
}

/**
 * Models the PLATFORM key answers on (the managed path), beside the BYOK
 * defaults above so a price sensitive change edits one file. Cheap tier by
 * default and deliberately its own table: this is the operator's money, and
 * moving the managed tier must never move what a customer's own key pays
 * for, or the reverse.
 */
export const PLATFORM_MODELS: Record<PlatformProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
}

const PROVIDER_LABEL = AI_PROVIDER_LABELS

/** How long a reply may run. Support answers are short; this caps cost. */
const REPLY_MAX_TOKENS = 1024

const ANTHROPIC_VERSION = '2023-06-01'

export type ChatTurn = { role: 'user' | 'assistant'; content: string }

export type ProviderReply = {
  text: string
  model: string
  inputTokens: number | null
  outputTokens: number | null
}

/**
 * A provider call failed. The message is a calm, plain language remediation for
 * an org admin (ruling B5), derived from the status code only. It never
 * contains the key, headers, or a response body.
 */
export class ProviderError extends Error {
  readonly provider: AiProvider
  readonly status: number
  constructor(provider: AiProvider, status: number) {
    super(remediation(provider, status))
    this.name = 'ProviderError'
    this.provider = provider
    this.status = status
  }
}

function remediation(provider: AiProvider, status: number): string {
  const name = PROVIDER_LABEL[provider]
  if (status === 401 || status === 403) {
    return `Your ${name} key was rejected. Check that the key is correct and active in your ${name} dashboard.`
  }
  if (status === 429) {
    return `Your ${name} account hit a rate limit or ran out of credit. Check usage and billing in your ${name} dashboard.`
  }
  if (status >= 500) {
    return `${name} had a problem on their end. Try again in a few minutes.`
  }
  return `The request to ${name} did not go through. Check your ${name} key and account.`
}

type CallOutcome = {
  provider: AiProvider
  model: string
  status: number
  ok: boolean
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
}

/**
 * The ONLY logging in this module. Ruling 4: provider, model, status, latency,
 * and token counts, nothing else. If a future edit adds the key, a header, or a
 * body to this line, tests/chat-provider-log-scrub.test.ts fails.
 */
function logCall(o: CallOutcome): void {
  // Token counts are omitted rather than sent as a placeholder when the
  // provider did not report them, so a consumer never has to know which
  // sentinel value means absent.
  const detail: LogDetail = {
    provider: o.provider,
    model: o.model,
    status: o.status,
    latency_ms: o.latencyMs,
  }
  if (o.inputTokens !== null) detail.in_tokens = o.inputTokens
  if (o.outputTokens !== null) detail.out_tokens = o.outputTokens
  logInfo('chat.provider.call', o.ok ? 'ok' : 'failed', detail)
}

// ---------------------------------------------------------------------------
// Request building and response parsing, per provider. The plaintext key is
// used to build headers here and is never returned, stored, or logged.

type BuiltRequest = { url: string; init: RequestInit }

function buildRequest(
  provider: AiProvider,
  apiKey: string,
  model: string,
  system: string,
  turns: ChatTurn[],
  maxTokens: number,
): BuiltRequest {
  const base = PROVIDER_BASE_URLS[provider]
  if (provider === 'anthropic') {
    return {
      url: `${base}/v1/messages`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: turns.map((t) => ({ role: t.role, content: t.content })),
        }),
      },
    }
  }
  if (provider === 'openai') {
    return {
      url: `${base}/v1/chat/completions`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            ...turns.map((t) => ({ role: t.role, content: t.content })),
          ],
        }),
      },
    }
  }
  // google. The key rides the x-goog-api-key header, NOT the URL query, so it
  // never lands in a logged or proxied URL.
  return {
    url: `${base}/v1beta/models/${model}:generateContent`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: turns.map((t) => ({
          role: t.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: t.content }],
        })),
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    },
  }
}

function parseResponse(provider: AiProvider, json: unknown): ProviderReply {
  const model = DEFAULT_MODELS[provider]
  if (provider === 'anthropic') {
    const j = json as {
      content?: Array<{ type?: string; text?: string }>
      model?: string
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    const text = (j.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
    return {
      text,
      model: j.model ?? model,
      inputTokens: j.usage?.input_tokens ?? null,
      outputTokens: j.usage?.output_tokens ?? null,
    }
  }
  if (provider === 'openai') {
    const j = json as {
      model?: string
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    return {
      text: j.choices?.[0]?.message?.content ?? '',
      model: j.model ?? model,
      inputTokens: j.usage?.prompt_tokens ?? null,
      outputTokens: j.usage?.completion_tokens ?? null,
    }
  }
  const j = json as {
    modelVersion?: string
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }
  const text = (j.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
  return {
    text,
    model: j.modelVersion ?? model,
    inputTokens: j.usageMetadata?.promptTokenCount ?? null,
    outputTokens: j.usageMetadata?.candidatesTokenCount ?? null,
  }
}

// ---------------------------------------------------------------------------

/**
 * Ask the provider for a reply, given the org's key, the system prompt, and the
 * conversation so far. Returns the assistant text plus provider, model, and
 * token counts for metering. Throws ProviderError on a non 2xx response, with a
 * remediation message safe to show an admin (chat surfaces a calmer version).
 */
export async function generateReply(opts: {
  provider: AiProvider
  apiKey: string
  system: string
  messages: ChatTurn[]
  model?: string
}): Promise<ProviderReply> {
  const model = opts.model ?? DEFAULT_MODELS[opts.provider]
  const { url, init } = buildRequest(
    opts.provider,
    opts.apiKey,
    model,
    opts.system,
    opts.messages,
    REPLY_MAX_TOKENS,
  )
  const start = Date.now()
  const res = await fetch(url, init)
  const latencyMs = Date.now() - start

  if (!res.ok) {
    // Do not read or log the body: it could carry provider detail we have no
    // reason to persist, and ruling 4 bars logging response bodies.
    logCall({
      provider: opts.provider,
      model,
      status: res.status,
      ok: false,
      latencyMs,
      inputTokens: null,
      outputTokens: null,
    })
    throw new ProviderError(opts.provider, res.status)
  }

  const reply = parseResponse(opts.provider, await res.json())
  logCall({
    provider: opts.provider,
    model,
    status: res.status,
    ok: true,
    latencyMs,
    inputTokens: reply.inputTokens,
    outputTokens: reply.outputTokens,
  })
  return reply
}

/**
 * Validate a key at save time (ruling 5): the cheapest possible call, a one
 * token completion, on the customer's key. Success returns; failure throws
 * ProviderError with a remediation message. Cost is negligible.
 */
export async function validateKey(
  provider: AiProvider,
  apiKey: string,
): Promise<void> {
  const model = DEFAULT_MODELS[provider]
  const { url, init } = buildRequest(
    provider,
    apiKey,
    model,
    'You are a test.',
    [{ role: 'user', content: 'hi' }],
    1,
  )
  const start = Date.now()
  const res = await fetch(url, init)
  const latencyMs = Date.now() - start
  logCall({
    provider,
    model,
    status: res.status,
    ok: res.ok,
    latencyMs,
    inputTokens: null,
    outputTokens: null,
  })
  if (!res.ok) {
    throw new ProviderError(provider, res.status)
  }
}
