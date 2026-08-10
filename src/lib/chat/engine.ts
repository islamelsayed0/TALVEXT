import 'server-only'

import { auth } from '@clerk/nextjs/server'

import { platformConfig, resolveManagedAccess } from '@/lib/billing/managed-ai'
import { createAdminClient } from '@/lib/db/admin'
import { createOrgScopedClient } from '@/lib/db/client'
import { errorName, logError } from '@/lib/log'
import { OrgNotSyncedError } from '@/lib/db/monitors'
import { titleFromMessage } from '@/lib/db/chat'
import type { AiProvider } from '@/lib/db/types'
import { readProviderKey } from './key-vault'
import { generateReply, PLATFORM_MODELS, type ChatTurn } from './providers'
import { isAiProvider } from './providers-meta'
import { checkChatRateLimit } from './rate-limit'
import {
  composeGrounding,
  EMPTY_GROUNDING,
  extractSearchTerms,
  retrieveGroundingArticles,
  type Grounding,
  type GroundingCitation,
} from './retrieval'
import { SYSTEM_PROMPT } from './system-prompt'

/**
 * The chat send path (Task 5). Runs for any member. It reads history and owns
 * conversation creation under the caller's own RLS, reads the org key through
 * the service role (the ciphertext is unreadable to a user session by design),
 * calls the provider, and writes both messages through the service role, since
 * chat_messages is system written like monitor_checks (migration 008).
 *
 * Non streaming with a loading state (Task 5 choice, stated in the PR):
 * streaming three providers through one abstraction with per provider SSE
 * parsing added real complexity for a support chat where replies are short, so
 * the pane shows a thinking indicator and renders the reply when it lands.
 */

const MESSAGE_MAX = 8000
/** How many prior turns to send the provider. Support chats are short; this
 * caps token cost and latency on a long conversation. */
const HISTORY_LIMIT = 40

export class ChatInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatInputError'
  }
}

export class ChatRateLimitError extends Error {
  readonly retryAfterMs: number
  constructor(retryAfterMs: number) {
    super('You are sending messages very quickly. Give it a moment and try again.')
    this.name = 'ChatRateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

/** The org has no usable key for the chosen (or only) provider. */
export class NoProviderKeyError extends Error {
  constructor() {
    super('The assistant needs an API key. Ask an admin to add one in settings.')
    this.name = 'NoProviderKeyError'
  }
}

/**
 * The month's included managed answers are used up (F13 PR 3). The recorded
 * degrade behavior: plain copy pointing at the Get Help ticket door. Never a
 * silent failure, never an automatic upgrade, never an overage charge.
 */
export class ManagedCapReachedError extends Error {
  constructor() {
    super(
      'This month’s included AI answers are used up. Send your question ' +
        'to your IT team from the Get Help page instead; the allowance resets ' +
        'next month, and nothing upgrades or gets charged on its own.',
    )
    this.name = 'ManagedCapReachedError'
  }
}

/**
 * The org is entitled to managed answers but the platform side cannot serve
 * one right now: the key is absent, or the provider refused it (spend limit
 * reached, rate limited, invalid key). The same honest degrade as the cap,
 * because to the person asking the truth is identical: no answer now, the
 * ticket door works, nothing upgrades or gets charged. Never a 500 and never
 * a silent hang.
 */
export class ManagedUnavailableError extends Error {
  constructor() {
    super(
      'The assistant is unavailable right now. Send your question to your ' +
        'IT team from the Get Help page instead; nothing upgrades or gets ' +
        'charged on its own.',
    )
    this.name = 'ManagedUnavailableError'
  }
}

/** More than one provider key exists and the caller did not choose one. */
export class ProviderChoiceRequiredError extends Error {
  readonly providers: AiProvider[]
  constructor(providers: AiProvider[]) {
    super('Choose which assistant to use.')
    this.name = 'ProviderChoiceRequiredError'
    this.providers = providers
  }
}

/** The conversation is not the caller's own, does not exist, or was escalated. */
export class ConversationUnavailableError extends Error {
  constructor() {
    super('That conversation is not available.')
    this.name = 'ConversationUnavailableError'
  }
}

export type SendOutcome = {
  conversationId: string
  /** True when this send created the conversation (first message). */
  created: boolean
  assistant: {
    id: string
    content: string
    provider: AiProvider
    model: string
    createdAt: string
    /** Articles that grounded this reply, for the reference cards. The ids
     * came from the caller's own scoped read, so they are already articles
     * this user may open. Empty when the reply was ungrounded. */
    citations: GroundingCitation[]
  }
}

/**
 * ONE attempt per answer, the platform key resilience rule: a retry here
 * would multiply spend on the operator's key, and the workspace spend limit
 * that backstops the database cap must never be probed twice for one
 * question. Exported for the unit suite; the send path is its only caller.
 *
 * A platform refusal (spend limit reached, rate limited, invalid key) posts
 * chat.platform_key.failed to the operator channel, name only, and degrades
 * to the managed unavailable copy. A BYOK failure passes through exactly as
 * before: it is the org's own key and the existing remediation names it.
 */
/** The operator channel hears about a platform refusal once per process:
 * the log line records every failure, but a spend limit outage with members
 * still typing must not flood the channel into being muted (the log module's
 * own reasoning for report being opt in). */
let platformFailureReported = false

export async function callProviderOnce(args: {
  keySource: 'byok' | 'platform'
  generate: () => ReturnType<typeof generateReply>
}): ReturnType<typeof generateReply> {
  try {
    return await args.generate()
  } catch (err) {
    if (args.keySource === 'platform') {
      logError(
        'chat.platform_key.failed',
        'failed',
        { error: errorName(err) },
        { report: !platformFailureReported },
      )
      platformFailureReported = true
      throw new ManagedUnavailableError()
    }
    throw err
  }
}

export async function sendChatMessage(input: {
  conversationId: string | null
  message: string
  provider: string | null
}): Promise<SendOutcome> {
  const message = input.message.trim()
  if (message === '') {
    throw new ChatInputError('Type a message first.')
  }
  if (message.length > MESSAGE_MAX) {
    throw new ChatInputError('That message is very long. Please shorten it.')
  }

  const { userId, orgId: clerkOrgId } = await auth()
  if (!userId || !clerkOrgId) {
    throw new Error('No signed in user or active organization on this session.')
  }

  const rate = checkChatRateLimit(clerkOrgId, userId)
  if (!rate.allowed) {
    throw new ChatRateLimitError(rate.retryAfterMs)
  }

  const { client } = await createOrgScopedClient()

  // Resolve the org uuid the key vault and message rows are keyed by.
  const { data: org, error: orgErr } = await client
    .from('organizations')
    .select('id')
    .eq('clerk_org_id', clerkOrgId)
    .maybeSingle()
  if (orgErr) throw orgErr
  if (!org) throw new OrgNotSyncedError()
  const orgUuid = org.id

  // Which provider. A member with one key needs no choice; with several, the
  // caller must have chosen (the picker). With none, the managed path (F13
  // PR 3) may serve the answer on the platform key IF the org's plan
  // includes managed answers and the month's allowance is not spent. BYOK
  // always wins when a key exists: it is free, uncapped, and never metered.
  const { data: providerRows, error: provErr } = await client.rpc(
    'org_api_key_providers',
  )
  if (provErr) throw provErr
  const providers = (providerRows ?? []).filter(isAiProvider)
  let provider: AiProvider
  let keySource: 'byok' | 'platform' = 'byok'
  if (input.provider && isAiProvider(input.provider) && providers.includes(input.provider)) {
    provider = input.provider
  } else if (providers.length === 1) {
    provider = providers[0]
  } else if (providers.length === 0) {
    const access = await resolveManagedAccess(clerkOrgId)
    if (access.mode === 'capped') {
      throw new ManagedCapReachedError()
    }
    if (access.mode === 'unavailable') {
      // Entitled, but the platform key is not configured: the paid for path
      // degrades like the cap, never to the ask an admin copy.
      throw new ManagedUnavailableError()
    }
    if (access.mode !== 'available') {
      throw new NoProviderKeyError()
    }
    const platform = platformConfig()
    if (!platform) {
      // Vanished between the access check and now; same honest degrade.
      throw new ManagedUnavailableError()
    }
    provider = platform.provider
    keySource = 'platform'
  } else {
    throw new ProviderChoiceRequiredError(providers)
  }

  // Resolve the conversation and gather history under the caller's own RLS.
  // Only the creator may post; an admin who can READ a member's conversation
  // cannot send into it. A NEW conversation is NOT created yet: we create it
  // and persist messages only after a successful reply, so a failed provider
  // call leaves nothing behind (no orphan conversation, and no lone user turn
  // that would break user/assistant alternation on the next request).
  let existingConversationId: string | null = null
  let reopen = false
  let history: ChatTurn[] = []

  if (input.conversationId) {
    const { data: convo, error: cErr } = await client
      .from('chat_conversations')
      .select('id, created_by, status')
      .eq('id', input.conversationId)
      .maybeSingle()
    if (cErr) throw cErr
    if (!convo || convo.created_by !== userId || convo.status === 'escalated') {
      throw new ConversationUnavailableError()
    }
    existingConversationId = convo.id
    reopen = convo.status === 'resolved'

    const { data: past, error: mErr } = await client
      .from('chat_messages')
      .select('role, content')
      .eq('conversation_id', existingConversationId)
      .order('created_at', { ascending: true })
    if (mErr) throw mErr
    history = (past ?? []).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }))
  }

  const turns: ChatTurn[] = [
    ...history.slice(-HISTORY_LIMIT),
    { role: 'user', content: message },
  ]

  // Knowledge base grounding (the F14 follow up). Retrieval runs on
  // `client`, the org scoped client built above from THIS request's session,
  // so the F14 visibility contract decides what the chat may see: the same
  // articles this user could open in Get Help, and nothing else. The service
  // role never touches articles. Any retrieval failure degrades to an
  // ungrounded answer; grounding is an enhancement, never a gate, and a
  // failure here must not take the chat down or tempt a wider client.
  let grounding: Grounding = EMPTY_GROUNDING
  try {
    const previousUserTurn = history.filter((t) => t.role === 'user').at(-1)?.content
    const terms = extractSearchTerms(message, previousUserTurn)
    const articles = await retrieveGroundingArticles(client, terms)
    grounding = composeGrounding(articles, terms)
  } catch (err) {
    // Still degrades to ungrounded, but no longer silently (audit L5): a
    // schema or RLS regression here would otherwise turn the knowledge base
    // off for a whole tenant invisibly. The name only; terms are tenant data.
    logError('chat.grounding.failed', 'failed', { error: errorName(err) })
    grounding = EMPTY_GROUNDING
  }

  // Read and decrypt the key in request scope, then call the provider. Nothing
  // is written until this succeeds. The managed path uses the platform key
  // and never touches the vault, and it answers on its own model table
  // (PLATFORM_MODELS): the operator's money moves independently of what a
  // customer's own key pays for.
  const platform = keySource === 'platform' ? platformConfig() : null
  const apiKey = platform ? platform.apiKey : await readProviderKey(orgUuid, provider)
  if (!apiKey) {
    // A key vanished between the provider list and now. On the platform path
    // that is the operator's configuration, not the org's admin, so it wears
    // the managed degrade, not the ask an admin copy.
    if (keySource === 'platform') throw new ManagedUnavailableError()
    throw new NoProviderKeyError()
  }

  const reply = await callProviderOnce({
    keySource,
    generate: () =>
      generateReply({
        provider,
        apiKey,
        ...(platform ? { model: PLATFORM_MODELS[platform.provider] } : {}),
        system: grounding.section
          ? `${SYSTEM_PROMPT}\n\n${grounding.section}`
          : SYSTEM_PROMPT,
        messages: turns,
      }),
  })

  const content =
    reply.text.trim() ||
    'Sorry, I could not generate a response just now. Please try again.'

  // Success. Create the conversation now if this is the first message, then
  // persist the user and assistant messages together (service role, since
  // chat_messages is system written). Persisting them as a pair keeps history
  // alternating.
  let conversationId = existingConversationId
  let created = false
  if (!conversationId) {
    const { data: convo, error: cErr } = await client
      .from('chat_conversations')
      .insert({
        org_id: orgUuid,
        created_by: userId,
        title: titleFromMessage(message),
      })
      .select('id')
      .single()
    if (cErr) throw cErr
    conversationId = convo.id
    created = true
  } else if (reopen) {
    // Chatting again on a resolved conversation reopens it.
    await client
      .from('chat_conversations')
      .update({ status: 'open' })
      .eq('id', conversationId)
  }

  const admin = createAdminClient()
  const { error: userMsgErr } = await admin.from('chat_messages').insert({
    org_id: orgUuid,
    conversation_id: conversationId,
    role: 'user',
    content: message,
  })
  if (userMsgErr) throw userMsgErr

  const { data: assistantRow, error: aErr } = await admin
    .from('chat_messages')
    .insert({
      org_id: orgUuid,
      conversation_id: conversationId,
      role: 'assistant',
      content,
      provider,
      model: reply.model,
      input_tokens: reply.inputTokens,
      output_tokens: reply.outputTokens,
      // The meter's input (migration 024): a platform row counts against the
      // org's monthly allowance, a byok row never does.
      key_source: keySource,
      // Ids only, never article content. What renders later goes back
      // through the viewer's own scoped articles read (migration 015).
      grounded_article_ids:
        grounding.citations.length > 0
          ? grounding.citations.map((c) => c.id)
          : null,
    })
    .select('id, created_at')
    .single()
  if (aErr) throw aErr

  return {
    conversationId,
    created,
    assistant: {
      id: assistantRow.id,
      content,
      provider,
      model: reply.model,
      createdAt: assistantRow.created_at,
      citations: grounding.citations,
    },
  }
}
