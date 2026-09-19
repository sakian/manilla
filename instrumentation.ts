/**
 * Boot-time checks.
 *
 * `register()` runs once and must finish before the server accepts requests,
 * which makes it the right place to refuse a configuration that would otherwise
 * fail later, at the worst moment. docker-compose.yml promises exactly this: in
 * production a missing or localhost relying-party ID stops the app rather than
 * quietly issuing sessions for the wrong origin.
 *
 * In development the same problem is a warning, because `next dev` on a checkout
 * with no .env yet should still come up.
 */

export async function register(): Promise<void> {
  const production = process.env.NODE_ENV === 'production';
  const { authConfig } = await import('./src/auth/config.ts');

  try {
    const config = authConfig(process.env, production);
    if (!production) {
      console.log(`[manilla] passkeys bound to ${config.rpId} at ${config.origin}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (production) {
      throw new Error(`Manilla refuses to start: ${message}`);
    }
    console.warn(`[manilla] sign-in will not work until this is fixed: ${message}`);
  }
}
