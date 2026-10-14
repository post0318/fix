import { NextResponse, type NextRequest } from "next/server";
import {
  deleteUploadedBond,
  getUploadedBond,
  listUploadedBonds,
  saveUploadedBond,
} from "@/lib/server/uploadedBonds";
import { isAdminEmail, requireTradingUser } from "@/lib/server/appAuth";
import type { BondLayoutInput } from "@/types/bondLayout";

const MAX_FIELDS = 40;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 업로드 채권 목록(공개 — 조회 가능한 모든 사람이 본다).
 * POST: 승인 계정만 올린다. DELETE: 올린 사람 본인 또는 관리자만 지운다.
 */
export async function GET() {
  try {
    // 올린 사람의 이메일은 공개하지 않는다. 로그인한 승인 계정에게만 "지울 수 있는지"를 알려 준다.
    const who = await requireTradingUser();
    const bonds = (await listUploadedBonds()).map(({ uploadedBy, ...pub }) => ({
      ...pub,
      canDelete: who.ok && (uploadedBy === who.email || isAdminEmail(who.email)),
    }));
    return NextResponse.json({ bonds });
  } catch (e) {
    console.error("[uploaded-bonds] 조회 실패", e);
    return NextResponse.json({ error: "조회하지 못했습니다." }, { status: 502 });
  }
}

/** 문자열 값만 받는다(숫자·불리언 필드는 업로드 파서가 문자열/불리언으로 만든 것만 통과). */
function sanitizeFields(raw: unknown): Partial<BondLayoutInput> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // 업로드 파서가 만드는 필드 이름(영문 camelCase)만, 개수·길이를 제한해 받는다.
    if (!/^[A-Za-z]{1,40}$/.test(k) || Object.keys(out).length >= MAX_FIELDS) continue;
    if (typeof v === "string") out[k] = v.slice(0, 500);
    else if (typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length ? (out as Partial<BondLayoutInput>) : null;
}

export async function POST(request: NextRequest) {
  const who = await requireTradingUser();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const body = (await request.json().catch(() => null)) as { fields?: unknown } | null;
  const fields = sanitizeFields(body?.fields);
  if (!fields) return NextResponse.json({ error: "채권 정보가 비어 있습니다." }, { status: 400 });
  const saved = await saveUploadedBond(fields, who.email);
  if ("error" in saved) return NextResponse.json(saved, { status: 409 });
  return NextResponse.json({ bond: saved });
}

export async function DELETE(request: NextRequest) {
  const who = await requireTradingUser();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const id = request.nextUrl.searchParams.get("id") ?? "";
  const bond = id ? await getUploadedBond(id) : null;
  if (!bond) return NextResponse.json({ error: "없는 채권입니다." }, { status: 404 });
  if (bond.uploadedBy !== who.email && !isAdminEmail(who.email)) {
    return NextResponse.json({ error: "올린 사람 또는 관리자만 지울 수 있습니다." }, { status: 403 });
  }
  await deleteUploadedBond(id);
  return NextResponse.json({ ok: true });
}
