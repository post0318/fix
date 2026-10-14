import { NextRequest, NextResponse } from "next/server";
import { fetchFwpDetail, isSecArchiveUrl } from "@/lib/server/secEdgar";

export async function GET(request: NextRequest) {
  const cik = request.nextUrl.searchParams.get("cik");
  const indexUrl = request.nextUrl.searchParams.get("indexUrl");
  const filedDate = request.nextUrl.searchParams.get("filedDate") ?? "";
  if (!cik || !indexUrl) {
    return NextResponse.json(
      { error: "cik, indexUrl 파라미터가 필요합니다." },
      { status: 400 }
    );
  }
  // 서버가 대신 가져오는 주소라 SEC 공시 보관소만 받는다(SSRF 차단, 2026-10-14)
  if (!/^\d{1,10}$/.test(cik) || !isSecArchiveUrl(indexUrl)) {
    return NextResponse.json({ error: "cik 또는 indexUrl 형식이 올바르지 않습니다." }, { status: 400 });
  }
  try {
    const detail = await fetchFwpDetail(indexUrl, cik, filedDate);
    return NextResponse.json(detail);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "조회 실패" },
      { status: 502 }
    );
  }
}
