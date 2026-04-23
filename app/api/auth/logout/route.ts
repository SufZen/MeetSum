import { NextResponse } from "next/server"

import { SESSION_COOKIE } from "@/lib/auth/session"

export async function POST() {
  const response = NextResponse.redirect(
    new URL("/en/login", process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000")
  )

  response.cookies.delete(SESSION_COOKIE)
  return response
}

export async function GET() {
  const response = NextResponse.redirect(
    new URL("/en/login", process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000")
  )

  response.cookies.delete(SESSION_COOKIE)
  return response
}
