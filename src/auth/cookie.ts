/**
 * The session cookie's name, and nothing else.
 *
 * It lives in its own module because `proxy.ts` runs on every request and only
 * needs this one string: importing it from `session.ts` would pull the database
 * client, the schema and Drizzle into the proxy bundle for the sake of a
 * constant.
 */

export const SESSION_COOKIE = 'manilla_session';
