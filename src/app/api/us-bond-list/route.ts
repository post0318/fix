import { NextRequest, NextResponse } from "next/server";
import { getRecentBondList } from "@/lib/server/secEdgar";
import { withLastGood } from "@/lib/server/redis";

export async function GET(request: NextRequest) {
  const cik = request.nextUrl.searchParams.get("cik");
  if (!cik) {
    return NextResponse.json({ error: "cik 파라미터가 필요합니다." }, { status: 400 });
  }
  try {
    // 원본 실패 시 마지막 정상값(staleSince = 저장 시각)
    const { value: bonds, staleSince } = await withLastGood(
      `api:us-bond-list:${cik}`,
      () => getRecentBondList(cik),
      (v) => v.length > 0
    );
    return NextResponse.json({ bonds, staleSince });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "조회 실패" },
      { status: 502 }
    );
  }
}
