import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  chatEntryMode,
  platformConfig,
  resolveManagedAccess,
  type PlatformProvider,
} from '@/lib/billing/managed-ai'
import { DEFAULT_MODELS, PLATFORM_MODELS } from '@/lib/chat/providers'
import {
  callProviderOnce,
  ManagedCapReachedError,
  ManagedUnavailableError,
} from '@/lib/chat/engine'

// getEntitlements is the only reach into the database on the branches under
// test here; mocked so the configuration edges are provable without a stack.
vi.mock('@/lib/billing/entitlements', () => ({
  getEntitlements: vi.fn(),
}))
import { getEntitlements } from '@/lib/billing/entitlements'
const getEntitlementsMock = vi.mocked(getEntitlements)

function entitled(aiAnswersIncluded: number) {
  return { aiAnswersIncluded } as Awaited<ReturnType<typeof getEntitlements>>
}

// The pure edges of the managed AI path (F13 PR 3). The meter itself is
// proven against the local stack in tests/isolation/managed-ai-isolation;
// what these pin is configuration behavior and the cap copy, which carries
// the recorded promises.

afterEach(() => {
  vi.unstubAllEnvs()
  getEntitlementsMock.mockReset()
})

// The provider matrix: every configuration rule must hold identically for
// both providers the platform key may run on.
const MATRIX: Array<{ provider: PlatformProvider; keyVar: string; otherKeyVar: string }> = [
  {
    provider: 'anthropic',
    keyVar: 'PLATFORM_ANTHROPIC_API_KEY',
    otherKeyVar: 'PLATFORM_OPENAI_API_KEY',
  },
  {
    provider: 'openai',
    keyVar: 'PLATFORM_OPENAI_API_KEY',
    otherKeyVar: 'PLATFORM_ANTHROPIC_API_KEY',
  },
]

function clearPlatformEnv() {
  vi.stubEnv('PLATFORM_AI_PROVIDER', '')
  vi.stubEnv('PLATFORM_ANTHROPIC_API_KEY', '')
  vi.stubEnv('PLATFORM_OPENAI_API_KEY', '')
}

describe.each(MATRIX)('platformConfig ($provider)', ({ provider, keyVar, otherKeyVar }) => {
  it('resolves the matching pair, key trimmed', () => {
    clearPlatformEnv()
    vi.stubEnv('PLATFORM_AI_PROVIDER', provider)
    vi.stubEnv(keyVar, '  the-key  ')
    expect(platformConfig()).toEqual({ provider, apiKey: 'the-key' })
  })

  it('is null when the matching key var is blank, whatever the other holds', () => {
    clearPlatformEnv()
    vi.stubEnv('PLATFORM_AI_PROVIDER', provider)
    vi.stubEnv(otherKeyVar, 'the-wrong-key')
    expect(platformConfig()).toBeNull()
  })

  it('is null when the provider is unset, even with this key present', () => {
    clearPlatformEnv()
    vi.stubEnv(keyVar, 'the-key')
    expect(platformConfig()).toBeNull()
  })
})

describe('platformConfig rejects what the engine cannot serve', () => {
  it('an unrecognized provider is null, never a crash', () => {
    clearPlatformEnv()
    vi.stubEnv('PLATFORM_AI_PROVIDER', 'google')
    vi.stubEnv('PLATFORM_ANTHROPIC_API_KEY', 'the-key')
    expect(platformConfig()).toBeNull()
  })
})

describe('the platform model table', () => {
  it('is cheap tier for both providers, separate from the BYOK defaults', () => {
    // Pinned literally: moving a managed model is a spend decision, made
    // here deliberately, never inherited from a BYOK default change.
    expect(PLATFORM_MODELS).toEqual({
      anthropic: 'claude-haiku-4-5',
      openai: 'gpt-4o-mini',
    })
    for (const provider of Object.keys(PLATFORM_MODELS) as PlatformProvider[]) {
      expect(typeof DEFAULT_MODELS[provider]).toBe('string')
    }
  })
})

describe.each(MATRIX)(
  'the missing key degrade, $provider (platform key resilience)',
  ({ provider }) => {
    it('an entitled org with the provider named but no key is unavailable, never none', () => {
      clearPlatformEnv()
      vi.stubEnv('PLATFORM_AI_PROVIDER', provider)
      getEntitlementsMock.mockResolvedValue(entitled(300))
      return expect(resolveManagedAccess('org_x')).resolves.toEqual({
        mode: 'unavailable',
      })
    })

    it('an unentitled org is none, whatever the pair situation', async () => {
      clearPlatformEnv()
      getEntitlementsMock.mockResolvedValue(entitled(0))
      await expect(resolveManagedAccess('org_x')).resolves.toEqual({ mode: 'none' })
      vi.stubEnv('PLATFORM_AI_PROVIDER', provider)
      vi.stubEnv(MATRIX.find((m) => m.provider === provider)!.keyVar, 'the-key')
      getEntitlementsMock.mockResolvedValue(entitled(0))
      await expect(resolveManagedAccess('org_x')).resolves.toEqual({ mode: 'none' })
    })

    it('chatEntryMode surfaces unavailable as its own door', async () => {
      clearPlatformEnv()
      vi.stubEnv('PLATFORM_AI_PROVIDER', provider)
      getEntitlementsMock.mockResolvedValue(entitled(300))
      await expect(chatEntryMode('org_x', false)).resolves.toBe('unavailable')
    })

    it('BYOK is untouched: a key holding org never consults the platform side', async () => {
      clearPlatformEnv()
      vi.stubEnv('PLATFORM_AI_PROVIDER', provider)
      await expect(chatEntryMode('org_x', true)).resolves.toBe('byok')
      expect(getEntitlementsMock).not.toHaveBeenCalled()
    })
  },
)

describe('the missing key degrade with nothing configured at all', () => {
  it('an entitled org is unavailable when both provider and keys are absent', () => {
    clearPlatformEnv()
    getEntitlementsMock.mockResolvedValue(entitled(300))
    return expect(resolveManagedAccess('org_x')).resolves.toEqual({
      mode: 'unavailable',
    })
  })
})

describe('callProviderOnce (platform key resilience)', () => {
  it('makes exactly one attempt, success passes through', async () => {
    const generate = vi.fn().mockResolvedValue({
      text: 'hi',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
    })
    const reply = await callProviderOnce({ keySource: 'platform', generate })
    expect(reply.text).toBe('hi')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('a platform refusal degrades to unavailable after one attempt, no retry', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('spend limit'))
    await expect(
      callProviderOnce({ keySource: 'platform', generate }),
    ).rejects.toBeInstanceOf(ManagedUnavailableError)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('a BYOK failure passes through unchanged: the org key path is unaffected', async () => {
    const original = new Error('provider said no')
    const generate = vi.fn().mockRejectedValue(original)
    await expect(callProviderOnce({ keySource: 'byok', generate })).rejects.toBe(
      original,
    )
    expect(generate).toHaveBeenCalledTimes(1)
  })
})

describe('the unavailable copy carries the recorded promises', () => {
  it('names the door and the nothing automatic promise', () => {
    const message = new ManagedUnavailableError().message
    expect(message).toContain('Get Help')
    expect(message).toMatch(/nothing upgrades or gets charged on its own/)
  })
})

describe('the cap copy carries the recorded promises', () => {
  // The substance, not the label (house testing rule): the degrade copy must
  // name the door (Get Help), the reset, and the no automatic upgrade or
  // charge promise. Losing any of these turns the recorded degrade behavior
  // into a dead end or a dark pattern.
  it('names the door, the reset, and the nothing automatic promise', () => {
    const message = new ManagedCapReachedError().message
    expect(message).toContain('Get Help')
    expect(message).toContain('resets next month')
    expect(message).toMatch(/nothing upgrades or gets charged on its own/)
  })
})
