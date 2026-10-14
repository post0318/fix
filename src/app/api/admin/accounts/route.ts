import { NextResponse, type NextRequest } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAdmin } from "@/lib/server/appAuth";

export const runtime = "nodejs";

/**
 * 계정 승인 관리 API — 관리자(ADMIN_EMAILS)만.
 *  GET  → 대기자(신청·승인됨·거절됨) + 사용자 목록
 *  POST { action: "invite" | "reject" | "ban" | "unban", id }
 *    invite: 대기자 승인 → Clerk 가 초대 메일 발송(비밀번호 설정 링크)
 *    reject: 대기자 거절
 *    ban / unban: 이미 계정이 있는 사용자의 접근 차단 / 해제 (삭제 대신 되돌릴 수 있게)
 */

export interface AdminWaitlistEntry {
  id: string;
  email: string;
  status: "pending" | "invited" | "completed" | "rejected";
  createdAt: string;
}
export interface AdminUser {
  id: string;
  email: string;
  banned: boolean;
  createdAt: string;
  lastSignInAt: string | null;
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export async function GET() {
  const who = await requireAdmin();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const client = await clerkClient();
  const [wl, us] = await Promise.all([
    client.waitlistEntries.list({ limit: 100, orderBy: "-created_at" }),
    client.users.getUserList({ limit: 100, orderBy: "-created_at" }),
  ]);

  const waitlist: AdminWaitlistEntry[] = wl.data.map((e) => ({
    id: e.id,
    email: e.emailAddress,
    status: e.status,
    createdAt: iso(e.createdAt) ?? "",
  }));
  const users: AdminUser[] = us.data.map((u) => ({
    id: u.id,
    email:
      u.emailAddresses.find((a) => a.id === u.primaryEmailAddressId)?.emailAddress ??
      u.emailAddresses[0]?.emailAddress ??
      "",
    banned: u.banned,
    createdAt: iso(u.createdAt) ?? "",
    lastSignInAt: iso(u.lastSignInAt),
  }));
  return NextResponse.json({ waitlist, users, me: who.email });
}

export async function POST(request: NextRequest) {
  const who = await requireAdmin();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  let body: { action?: unknown; id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문이 JSON 이 아닙니다." }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  const action = body.action;
  if (!id || !["invite", "reject", "ban", "unban"].includes(String(action))) {
    return NextResponse.json({ error: "action/id 가 올바르지 않습니다." }, { status: 400 });
  }

  const client = await clerkClient();
  try {
    if (action === "invite") await client.waitlistEntries.invite(id);
    else if (action === "reject") await client.waitlistEntries.reject(id);
    else if (action === "ban") {
      // 관리자 자신은 차단 불가
      if (id === who.userId) {
        return NextResponse.json({ error: "자기 자신은 차단할 수 없습니다." }, { status: 400 });
      }
      await client.users.banUser(id);
    } else if (action === "unban") await client.users.unbanUser(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg =
      (e as { errors?: { longMessage?: string; message?: string }[] })?.errors?.[0]?.longMessage ??
      (e as { errors?: { message?: string }[] })?.errors?.[0]?.message ??
      (e instanceof Error ? e.message : "처리에 실패했습니다.");
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
