import { NextResponse, type NextRequest } from "next/server";

// Pathname passthrough — NOT auth. The dashboard authenticates by unsealing the
// WorkOS cookie directly in RSCs (we deliberately run without the AuthKit proxy
// middleware for OpenNext/Cloudflare). But a Server Component can't read its own
// URL, so the auth gate in lib/api-client.ts has no way to know which page a
// session-expired user was on. This middleware stamps the current path+query
// into the `x-pathname` request header so the gate can thread it back as a
// `returnTo`, landing the user where they were after re-auth. It touches no
// cookies and makes no auth decision.
export const middleware = (request: NextRequest): NextResponse => {
  const headers = new Headers(request.headers);
  headers.set(
    "x-pathname",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );
  return NextResponse.next({ request: { headers } });
};

export const config = {
  // Skip Next internals, static assets, and the auth routes themselves — we
  // never want /callback or /sign-up captured as a returnTo target.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sign-in|sign-up|sign-out|callback|api/).*)",
  ],
};
