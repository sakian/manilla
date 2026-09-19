/**
 * Route gate in front of the app (NF-3).
 *
 * In Next 16 this file is `proxy.ts`; it was `middleware.ts` until the rename.
 *
 * This is the *optimistic* half of the check: it runs on every request, including
 * prefetches, so it only asks whether a session cookie is present and never
 * touches the database. The authoritative check is `requireUser()` in app/auth.ts,
 * which runs next to the data it is protecting - so a forged or expired cookie
 * gets a page render and then a redirect, not access.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from './src/auth/cookie.ts';

/**
 * Reachable without a session: signing in, the container health check, and - in
 * development only, guarded inside the route itself - the CA certificate a phone
 * needs before it will do passkeys over a LAN certificate at all.
 */
const PUBLIC_PATHS = ['/login', '/api/health', '/api/dev-ca'];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const signedIn = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (!signedIn && !isPublic(pathname)) {
    const login = new URL('/login', request.url);
    // Come back to where they were headed once they are in.
    if (pathname !== '/') login.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  // Deliberately no redirect away from /login for a request that merely *has* a
  // cookie: a stale one would bounce between /login and / for ever, because only
  // the page can tell whether the session behind it is real. The sign-in page
  // makes that check itself and redirects when it is.
  return NextResponse.next();
}

export const config = {
  // Everything but Next's own assets and the favicon: auth checks that skip
  // routes are auth checks with a hole in them.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
