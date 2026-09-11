import { NextRequest, NextResponse } from "next/server";
import { findCallPutTermsByIsin } from "@/lib/server/secEdgar";

/**
 * 콜/풋 체크박스 재조회용 — 검색을 거치지 않고 체크박스만 켰을 때(또는
 * "다시 확인" 클릭 시) 이미 반영된 ISIN으로 콜/풋 조항을 다시 조회한다.
 */
export async function GET(request: NextRequest) {
  const isin = request.nextUrl.searchParams.get("isin");
  if (!isin) {
    return NextResponse.json({ error: "isin 파라미터가 필요합니다." }, { status: 400 });
  }
  try {
    const tranche = await findCallPutTermsByIsin(isin);
    if (!tranche) {
      return NextResponse.json({ found: false });
    }
    return NextResponse.json({ found: true, tranche });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "조회 실패" },
      { status: 502 }
    );
  }
}
