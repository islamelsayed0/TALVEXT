import 'server-only'

import { decryptApiKey } from '@/lib/chat/encryption'
import { createAdminClient } from '@/lib/db/admin'

/**
 * Reads and decrypts one Azure connection's service principal secret for a
 * single pull (the key-vault.ts construction, security rulings 2/3). This is
 * the ONLY place the plaintext secret exists after save.
 *
 * Why the service role: the encrypted_secret column is withheld from the
 * authenticated SELECT grant (migration 026), so no user session, not even
 * the admin who pasted it, can read the ciphertext. The cron sweep carries
 * no user session at all, so it reads here, through the narrow service role
 * exception (see the allowlist in admin.ts), by connection id, and decrypts
 * in request scope.
 *
 * The returned plaintext is used immediately for one token request and then
 * goes out of scope. It is never stored, never cached, and never logged.
 */
export async function readConnectionSecret(connectionId: string): Promise<string | null> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('azure_connections')
    .select('encrypted_secret')
    .eq('id', connectionId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return decryptApiKey(data.encrypted_secret)
}
