import { NextRequest, NextResponse } from "next/server";
import { fetchFxRate } from "@/lib/server/fxRate";

export async function GET(request: NextRequest) {
  const base = request.nextUrl.searchParams.get("base");
  const quote = request.nextUrl.searchParams.get("quote");
  if (!base || !quote) {
    return NextResponse.json(
      { error: "base/quote 파라미터가 필요합니다." },
      { status: 400 }
    );
  }
  if (!/^[A-Za-z]{3}$/.test(base) || !/^[A-Za-z]{3}$/.test(quote)) {
    return NextResponse.json({ error: "통화 코드는 영문 3자입니다." }, { status: 400 });
  }
  try {
    const rate = await fetchFxRate(base, quote);
    return NextResponse.json({ rate });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "조회 실패" },
      { status: 502 }
    );
  }
}
