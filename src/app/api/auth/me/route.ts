import { NextResponse } from "next/server";
import { clerkConfigured, isAdminEmail, requireTradingUser } from "@/lib/server/appAuth";

export const runtime = "nodejs";

/**
 * 현재 로그인 계정이 출력·업로드를 쓸 수 있는지. 허용 판단(회사 도메인
 * 또는 관리자 목록)은 서버에서만 하고, 관리자 이메일 목록은 화면에 내려보내지 않는다.
 */
export async function GET() {
  if (!clerkConfigured()) {
    return NextResponse.json({ enabled: false, signedIn: false, allowed: false, admin: false, email: null });
  }
  const who = await requireTradingUser();
  if (who.ok) {
    return NextResponse.json({
      enabled: true,
      signedIn: true,
      allowed: true,
      admin: isAdminEmail(who.email),
      email: who.email,
    });
  }
  return NextResponse.json({
    enabled: true,
    signedIn: who.status !== 401,
    allowed: false,
    admin: false,
    email: null,
    reason: who.error,
  });
}
