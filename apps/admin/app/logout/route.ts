import { NextResponse } from "next/server";

import { SESSION_COOKIE } from "@/lib/session-crypto";

export function GET(req: Request): NextResponse {
  const res = NextResponse.redirect(new URL("/login", req.url));
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
