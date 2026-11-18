import { NextResponse, type NextRequest } from 'next/server';

/**
 * One codebase, two deployments. APP_SURFACE selects what a deployment serves:
 *
 *   chatbot — the public chat only. Admin pages and admin APIs answer 404.
 *   admin   — the admin portal. "/" goes to /admin. The chat APIs stay available
 *             because the admin chat and testing pages call them.
 *   (unset) — everything, as in local development.
 *
 * Admin APIs still enforce their own authentication; this only hides them.
 * The upload route is left out of the matcher so proxy body buffering (10 MB)
 * never truncates an upload; it requires an admin session regardless.
 */
export function proxy(request: NextRequest) {
  const surface = process.env.APP_SURFACE;
  const { pathname } = request.nextUrl;

  if (surface === 'chatbot' && (pathname.startsWith('/admin') || pathname.startsWith('/api/admin'))) {
    return pathname.startsWith('/api/')
      ? NextResponse.json({ error: 'Not found' }, { status: 404 })
      : NextResponse.rewrite(new URL('/_not-found', request.url), { status: 404 });
  }

  if (surface === 'admin' && pathname === '/') {
    return NextResponse.redirect(new URL('/admin', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/', '/admin', '/admin/:path*', '/api/admin/((?!documents/upload).*)'],
};
