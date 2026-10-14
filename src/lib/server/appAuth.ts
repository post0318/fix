import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";

/**
 * 출력·업로드 허용 판정과 계정 승인 관리의 서버 측 잠금(4번 프로젝트와 같은 방식).
 * Clerk 세션이 있고, 그 계정의 이메일이 허용 도메인
 * (`ALLOWED_EMAIL_DOMAINS`, 기본 hanwha.com)에 속하거나 관리자 목록
 * (`ADMIN_EMAILS`)에 있어야 통과한다.
 *
 * 대기자(Waitlist) 모드에서는 관리자가 승인한 사람만 Clerk 사용자로 존재하므로,
 * 세션이 있다는 것 자체가 "승인됨"을 뜻한다. 도메인 검사는 승인 실수를 막는
 * 두 번째 방어선이다.
 */

export function allowedEmailDomains(): string[] {
  const raw = process.env.ALLOWED_EMAIL_DOMAINS ?? "hanwha.com";
  return raw
    .split(/[,;\s]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

export function clerkConfigured(): boolean {
  return !!process.env.CLERK_SECRET_KEY && !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
}

/** 도메인과 무관하게 통과하는 관리자 이메일(`ADMIN_EMAILS`, 쉼표 구분) */
function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (adminEmails().includes(e)) return true;
  const at = e.lastIndexOf("@");
  if (at < 0) return false;
  return allowedEmailDomains().includes(e.slice(at + 1));
}

export function isAdminEmail(email: string): boolean {
  return adminEmails().includes(email.trim().toLowerCase());
}

/**
 * userId → 이메일 캐시.
 *
 * `currentUser()` 는 Clerk Backend API(GET /v1/users/{id})를 네트워크로 부른다.
 * 보호된 요청마다 왕복이 한 번씩 붙어 체감 지연이 컸다(사용자 지적). 세션 검증
 * (`auth()`)은 토큰 서명만 보므로 빠르고, 이메일은 거의 바뀌지 않으므로 짧게
 * 캐시한다. 세션이 끊기거나 차단되면 `auth()` 단계에서 막히므로 캐시가
 * 권한을 늘려주지는 않는다.
 */
const EMAIL_TTL_MS = 5 * 60 * 1000;
const emailCache = new Map<string, { email: string; at: number }>();

async function emailOf(userId: string): Promise<string> {
  const hit = emailCache.get(userId);
  if (hit && Date.now() - hit.at < EMAIL_TTL_MS) return hit.email;

  const user = await currentUser();
  const email =
    user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? "";
  if (email) {
    // 캐시가 무한정 자라지 않게 — 사내 인원 규모라 상한이 넉넉하다.
    if (emailCache.size > 200) emailCache.clear();
    emailCache.set(userId, { email, at: Date.now() });
  }
  return email;
}

export type TradingUserResult =
  | { ok: true; email: string; userId: string }
  | { ok: false; status: 401 | 403 | 503; error: string };

export async function requireTradingUser(): Promise<TradingUserResult> {
  if (!clerkConfigured()) {
    return { ok: false, status: 503, error: "인증 서비스(Clerk)가 설정되지 않았습니다." };
  }
  const { userId } = await auth();
  if (!userId) return { ok: false, status: 401, error: "로그인이 필요합니다." };

  const email = await emailOf(userId);
  if (!email || !isAllowedEmail(email)) {
    return {
      ok: false,
      status: 403,
      error: `회사 이메일(${allowedEmailDomains().map((d) => "@" + d).join(", ")}) 계정만 사용할 수 있습니다.`,
    };
  }
  return { ok: true, email, userId };
}

/** 계정 승인 관리 — ADMIN_EMAILS 에 있는 계정만 */
export async function requireAdmin(): Promise<TradingUserResult> {
  const who = await requireTradingUser();
  if (!who.ok) return who;
  if (!isAdminEmail(who.email)) {
    return { ok: false, status: 403, error: "관리자만 들어올 수 있습니다." };
  }
  return who;
}

/** 서버 렌더링 시점의 인증 상태 — 화면이 /api/auth/me 를 다시 부르지 않게 한다. */
export interface InitialAuthState {
  userId: string | null;
  signedIn: boolean;
  allowed: boolean;
  admin: boolean;
  email: string | null;
  reason: string | null;
}

export async function resolveAuthState(): Promise<InitialAuthState> {
  const who = await requireTradingUser();
  if (who.ok) {
    return {
      userId: who.userId,
      signedIn: true,
      allowed: true,
      admin: isAdminEmail(who.email),
      email: who.email,
      reason: null,
    };
  }
  // 401 은 로그인 안 함, 403 은 로그인했지만 허용 도메인/관리자 아님
  return {
    userId: null,
    signedIn: who.status === 403,
    allowed: false,
    admin: false,
    email: null,
    reason: who.status === 401 ? null : who.error,
  };
}
