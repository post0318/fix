import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Clerk 세션을 요청에 붙이는 Next 16 Proxy(구 middleware). 여기서는 아무것도
 * 막지 않는다 — 실제 잠금은 각 API 라우트가 `requireTradingUser()`로 하고, 화면은
 * 출력·업로드 허용 여부를 `useAppAuth()`로 본다.
 *
 * Clerk 키가 없으면(로컬 초기 상태, CI) 통과시켜 앱 나머지는 그대로 돌게 한다.
 */
const clerkConfigured =
  !!process.env.CLERK_SECRET_KEY && !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export default clerkConfigured ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  matcher: [
    // 정적 파일·Next 내부 경로 제외
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // API 는 항상
    "/(api|trpc)(.*)",
  ],
};
