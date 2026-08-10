import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { decryptApiKey, encryptApiKey } from '@/lib/chat/encryption'
import {
  CLAIM_SHAPES,
  createAnonClient,
  createMemberClient,
  createServiceClient,
  memberToken,
  type ClaimShape,
  type TestClient,
} from './local-stack'
import { preflight } from './local-stack'

// Isolation proof for Azure cost monitoring (BRD F23, migration 026): the
// first table holding a customer's CLOUD credentials, so the BYOK rulings
// apply in full. Extends the suite per CLAUDE.md rules 2 and 8 (never skip,
// weaken, or delete). Enforced at the database and proven here:
//   - NO CIPHERTEXT TO CLIENTS: encrypted_secret is not in the authenticated
//     SELECT grant, so not even the admin who pasted it can read it back.
//   - ENCRYPTED AT REST: the stored column never contains the plaintext; it
//     decrypts back to the known secret through the service role only.
//   - ADMIN ONLY: a member has no access to connections OR rollups at all.
//     Spend is money data, scoped like billing, not like uptime.
//   - SWEEP OWNED LEDGERS: last_pull_at, last_pull_status, last_success_at,
//     and budget_alerted_for_month hold no authenticated write grant, so an
//     org cannot forge freshness or replay a budget alert by clearing its
//     own dedup stamp.
//   - CROSS ORG: org B sees nothing of org A's connections or costs and
//     cannot write into A.
//   - AUDIT: connect, budget change, and disconnect are trigger recorded,
//     and the budget detail carries the field NAME only, never the amount.
//
// Obviously fake credential material only; the GUIDs are test values and the
// secret is an unmistakable fake.
const TEST_SECRET = 'a1b2c3d4'.repeat(8) // 64 hex = 32 bytes // gitleaks:allow
process.env.API_KEY_ENCRYPTION_SECRET = TEST_SECRET

const KNOWN_SECRET_A = 'FAKE-AZURE-SECRET-orgA-abcdef123456' // gitleaks:allow

const GUIDS = {
  subA: '11111111-aaaa-4111-8111-111111111111',
  tenantA: '22222222-aaaa-4222-8222-222222222222',
  clientA: '33333333-aaaa-4333-8333-333333333333',
  subB: '44444444-bbbb-4444-8444-444444444444',
  tenantB: '55555555-bbbb-4555-8555-555555555555',
  clientB: '66666666-bbbb-4666-8666-666666666666',
}

const runId = randomUUID()
const seed = {
  orgA: { clerk_org_id: `org_azure_a_${runId}`, name: 'Azure Test Org A' },
  orgB: { clerk_org_id: `org_azure_b_${runId}`, name: 'Azure Test Org B' },
  adminA: `user_azure_admin_a_${runId}`,
  memberA: `user_azure_member_a_${runId}`,
  adminB: `user_azure_admin_b_${runId}`,
}

let service: TestClient
let orgAId: string
let orgBId: string
let connectionAId: string
let seeded = false

const asUser = (
  clerkUserId: string,
  clerkOrgId: string,
  shape: ClaimShape,
  claimRole?: 'member' | 'admin',
) => createMemberClient(memberToken({ clerkUserId, clerkOrgId, shape, claimRole }))

beforeAll(async () => {
  await preflight()
  service = createServiceClient()

  const { data: orgs, error: orgErr } = await service
    .from('organizations')
    .insert([seed.orgA, seed.orgB])
    .select()
  if (orgErr || orgs.length !== 2) {
    throw new Error(`Seeding organizations failed: ${orgErr?.message}`)
  }
  orgAId = orgs.find((o) => o.clerk_org_id === seed.orgA.clerk_org_id)!.id
  orgBId = orgs.find((o) => o.clerk_org_id === seed.orgB.clerk_org_id)!.id

  const { error: memberErr } = await service.from('org_members').insert([
    { org_id: orgAId, clerk_user_id: seed.adminA, role: 'admin' },
    { org_id: orgAId, clerk_user_id: seed.memberA, role: 'member' },
    { org_id: orgBId, clerk_user_id: seed.adminB, role: 'admin' },
  ])
  if (memberErr) throw new Error(`Seeding org_members failed: ${memberErr.message}`)

  // Seed org A's connection through ADMIN A's OWN RLS session, proving the
  // admin insert policy and firing the audit trigger. The token claim stays
  // the default member, proving the database column is the role authority.
  const { data: conn, error: insErr } = await asUser(seed.adminA, seed.orgA.clerk_org_id, 'legacy')
    .from('azure_connections')
    .insert({
      org_id: orgAId,
      subscription_id: GUIDS.subA,
      tenant_id: GUIDS.tenantA,
      client_id: GUIDS.clientA,
      encrypted_secret: encryptApiKey(KNOWN_SECRET_A),
      created_by: seed.adminA,
    })
    .select('id')
    .single()
  if (insErr || !conn) {
    throw new Error(`Seeding org A connection as admin failed (admin policy?): ${insErr?.message}`)
  }
  connectionAId = conn.id

  // Org B gets a connection and both orgs get rollups, via the service role
  // (the sweep's role), so cross org reads have something real to miss.
  const { error: connBErr } = await service.from('azure_connections').insert({
    org_id: orgBId,
    subscription_id: GUIDS.subB,
    tenant_id: GUIDS.tenantB,
    client_id: GUIDS.clientB,
    encrypted_secret: encryptApiKey('FAKE-AZURE-SECRET-orgB'), // gitleaks:allow
    created_by: seed.adminB,
  })
  if (connBErr) throw new Error(`Seeding org B connection failed: ${connBErr.message}`)

  const { error: costErr } = await service.from('azure_daily_costs').insert([
    {
      org_id: orgAId,
      subscription_id: GUIDS.subA,
      day: '2026-08-01',
      total_cost: 12.34,
      currency: 'USD',
      by_service: { 'Virtual Machines': 10.0, Storage: 2.34 },
    },
    {
      org_id: orgBId,
      subscription_id: GUIDS.subB,
      day: '2026-08-01',
      total_cost: 99.99,
      currency: 'USD',
      by_service: { 'Bravo Service Bravo': 99.99 },
    },
  ])
  if (costErr) throw new Error(`Seeding rollups failed: ${costErr.message}`)

  seeded = true
}, 60_000)

afterAll(async () => {
  if (!seeded) return
  await service
    .from('organizations')
    .delete()
    .in('clerk_org_id', [seed.orgA.clerk_org_id, seed.orgB.clerk_org_id])
})

describe('control: the seed exists and admins read their own metadata', () => {
  it('admin A sees exactly their connection, without the secret', async () => {
    const { data, error } = await asUser(seed.adminA, seed.orgA.clerk_org_id, 'v2')
      .from('azure_connections')
      .select('subscription_id, tenant_id, client_id, last_pull_status, monthly_budget')
    expect(error).toBeNull()
    expect(data).toEqual([
      {
        subscription_id: GUIDS.subA,
        tenant_id: GUIDS.tenantA,
        client_id: GUIDS.clientA,
        last_pull_status: null,
        monthly_budget: null,
      },
    ])
  })

  it('admin A sees exactly their rollup row', async () => {
    const { data, error } = await asUser(seed.adminA, seed.orgA.clerk_org_id, 'legacy')
      .from('azure_daily_costs')
      .select('subscription_id, total_cost')
    expect(error).toBeNull()
    expect(data).toEqual([{ subscription_id: GUIDS.subA, total_cost: 12.34 }])
  })
})

describe('encrypted at rest', () => {
  it('the stored column is ciphertext, never the plaintext, and decrypts back', async () => {
    const { data, error } = await service
      .from('azure_connections')
      .select('encrypted_secret')
      .eq('id', connectionAId)
      .single()
    expect(error).toBeNull()
    expect(data!.encrypted_secret).not.toBe(KNOWN_SECRET_A)
    expect(data!.encrypted_secret).not.toContain(KNOWN_SECRET_A)
    expect(decryptApiKey(data!.encrypted_secret)).toBe(KNOWN_SECRET_A)
  })
})

describe('an admin cannot read the ciphertext through RLS', () => {
  it('selecting encrypted_secret as the OWNING admin is refused at the column grant', async () => {
    const { error } = await asUser(seed.adminA, seed.orgA.clerk_org_id, 'legacy')
      .from('azure_connections')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select('encrypted_secret' as any)
    expect(error).not.toBeNull()
  })

  it('select() without columns (the star select) is refused too, so no default query leaks it', async () => {
    const { error } = await asUser(seed.adminA, seed.orgA.clerk_org_id, 'v2')
      .from('azure_connections')
      .select()
    expect(error).not.toBeNull()
  })
})

describe('sweep owned ledgers hold no authenticated write grant', () => {
  it.each([
    ['last_pull_at', { last_pull_at: new Date().toISOString() }],
    ['last_pull_status', { last_pull_status: 'ok' }],
    ['last_success_at', { last_success_at: new Date().toISOString() }],
    ['budget_alerted_for_month', { budget_alerted_for_month: '2026-08-01' }],
  ])('an admin updating %s is refused at the column grant', async (_column, patch) => {
    const { error } = await asUser(seed.adminA, seed.orgA.clerk_org_id, 'legacy')
      .from('azure_connections')
      .update(patch)
      .eq('id', connectionAId)
    expect(error).not.toBeNull()
    expect(`${error?.code} ${error?.message}`).toMatch(/42501|permission denied/i)
  })

  it('an admin cannot write a rollup row', async () => {
    const { error } = await asUser(seed.adminA, seed.orgA.clerk_org_id, 'v2')
      .from('azure_daily_costs')
      .insert({
        org_id: orgAId,
        subscription_id: GUIDS.subA,
        day: '2026-08-02',
        total_cost: 0,
        currency: 'USD',
      })
    expect(error).not.toBeNull()
    expect(`${error?.code} ${error?.message}`).toMatch(/42501|permission denied/i)
  })

  it('an admin cannot rewrite or delete rollup history', async () => {
    await asUser(seed.adminA, seed.orgA.clerk_org_id, 'legacy')
      .from('azure_daily_costs')
      .update({ total_cost: 0 })
      .eq('org_id', orgAId)
    await asUser(seed.adminA, seed.orgA.clerk_org_id, 'legacy')
      .from('azure_daily_costs')
      .delete()
      .eq('org_id', orgAId)
    const { data } = await service
      .from('azure_daily_costs')
      .select('total_cost')
      .eq('org_id', orgAId)
    expect(data).toEqual([{ total_cost: 12.34 }])
  })
})

describe('what an admin MAY write still works (the grant split control)', () => {
  it('setting a monthly budget succeeds and audits the field name, never the amount', async () => {
    const { error } = await asUser(seed.adminA, seed.orgA.clerk_org_id, 'v2')
      .from('azure_connections')
      .update({ monthly_budget: 250 })
      .eq('id', connectionAId)
    expect(error).toBeNull()

    const { data: entries } = await service
      .from('audit_log')
      .select('action, actor, detail')
      .eq('org_id', orgAId)
      .eq('action', 'azure_budget_changed')
    expect(entries).toHaveLength(1)
    expect(entries![0].actor).toBe(seed.adminA)
    expect(entries![0].detail).toEqual({
      subscription_id: GUIDS.subA,
      changed: ['monthly_budget'],
    })
    // The substance of the field-names-only rule: the amount appears nowhere.
    expect(JSON.stringify(entries![0].detail)).not.toContain('250')
  })

  it('the connect itself was audited with the admin as actor', async () => {
    const { data } = await service
      .from('audit_log')
      .select('actor, detail')
      .eq('org_id', orgAId)
      .eq('action', 'azure_connected')
    expect(data).toHaveLength(1)
    expect(data![0].actor).toBe(seed.adminA)
    expect(data![0].detail).toEqual({ subscription_id: GUIDS.subA })
  })
})

describe.each(CLAIM_SHAPES)('members have no access at all (%s claim shape)', (shape) => {
  const asMemberA = () => asUser(seed.memberA, seed.orgA.clerk_org_id, shape)

  it('a member cannot select connections, even in their own org', async () => {
    const { data, error } = await asMemberA()
      .from('azure_connections')
      .select('subscription_id')
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('a member cannot select costs: spend is admin data', async () => {
    const { data, error } = await asMemberA().from('azure_daily_costs').select('total_cost')
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('an admin token CLAIM does not grant access when the column says member', async () => {
    const claimingAdmin = asUser(seed.memberA, seed.orgA.clerk_org_id, shape, 'admin')
    const { data } = await claimingAdmin.from('azure_connections').select('subscription_id')
    expect(data).toEqual([])
  })
})

describe.each(CLAIM_SHAPES)('cross org isolation (%s claim shape)', (shape) => {
  it('org B admin sees nothing of org A connections or costs', async () => {
    const asAdminB = asUser(seed.adminB, seed.orgB.clerk_org_id, shape)
    const connections = await asAdminB.from('azure_connections').select('subscription_id')
    expect(connections.error).toBeNull()
    expect(
      connections.data,
      `org A connection leaked into org B: ${GUIDS.subA}`,
    ).toEqual([{ subscription_id: GUIDS.subB }])
    const costs = await asAdminB.from('azure_daily_costs').select('subscription_id, total_cost')
    expect(costs.error).toBeNull()
    expect(costs.data, 'org A costs leaked into org B').toEqual([
      { subscription_id: GUIDS.subB, total_cost: 99.99 },
    ])
  })

  it('org B admin cannot connect a subscription into org A', async () => {
    const { error } = await asUser(seed.adminB, seed.orgB.clerk_org_id, shape)
      .from('azure_connections')
      .insert({
        org_id: orgAId, // A's org, out of bounds for B
        subscription_id: '77777777-cccc-4777-8777-777777777777',
        tenant_id: GUIDS.tenantB,
        client_id: GUIDS.clientB,
        encrypted_secret: encryptApiKey('FAKE-AZURE-SECRET-cross'), // gitleaks:allow
        created_by: seed.adminB,
      })
    expect(error).not.toBeNull()
    // A is unchanged: still exactly one connection.
    const { data } = await service.from('azure_connections').select('id').eq('org_id', orgAId)
    expect(data).toHaveLength(1)
  })

  it('org B admin cannot set a budget on org A (matches zero rows)', async () => {
    await asUser(seed.adminB, seed.orgB.clerk_org_id, shape)
      .from('azure_connections')
      .update({ monthly_budget: 1 })
      .eq('id', connectionAId)
    const { data } = await service
      .from('azure_connections')
      .select('monthly_budget')
      .eq('id', connectionAId)
      .single()
    // 250 from the budget test above, or null if ordering ever changes;
    // either way, never B's 1.
    expect(data!.monthly_budget).not.toBe(1)
  })
})

describe('anon has nothing: refused at the grant layer, not just empty', () => {
  it('anon cannot select connections or costs', async () => {
    const anon = createAnonClient()
    const connections = await anon.from('azure_connections').select('subscription_id')
    expect(connections.error).not.toBeNull()
    expect(`${connections.error?.code} ${connections.error?.message}`).toMatch(
      /42501|permission denied/i,
    )
    const costs = await anon.from('azure_daily_costs').select('total_cost')
    expect(costs.error).not.toBeNull()
    expect(`${costs.error?.code} ${costs.error?.message}`).toMatch(/42501|permission denied/i)
  })
})

describe('disconnect keeps the history and audits', () => {
  it('deleting the connection as its admin leaves the rollups and records azure_disconnected', async () => {
    const { error } = await asUser(seed.adminA, seed.orgA.clerk_org_id, 'legacy')
      .from('azure_connections')
      .delete()
      .eq('id', connectionAId)
    expect(error).toBeNull()

    // The credential is gone; the history is not.
    const { data: gone } = await service
      .from('azure_connections')
      .select('id')
      .eq('org_id', orgAId)
    expect(gone).toEqual([])
    const { data: history } = await service
      .from('azure_daily_costs')
      .select('total_cost')
      .eq('org_id', orgAId)
    expect(history).toEqual([{ total_cost: 12.34 }])

    const { data: audit } = await service
      .from('audit_log')
      .select('actor, detail')
      .eq('org_id', orgAId)
      .eq('action', 'azure_disconnected')
    expect(audit).toHaveLength(1)
    expect(audit![0].actor).toBe(seed.adminA)
    expect(audit![0].detail).toEqual({ subscription_id: GUIDS.subA })
  })
})
