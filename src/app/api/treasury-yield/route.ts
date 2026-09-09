import { NextResponse } from "next/server";
import { getTreasuryParYieldCurve } from "@/lib/server/treasuryYieldCurve";

/** 미 재무부 일별 국채 par yield curve 최신값. make-whole 상환가 계산의 기준금리 자동채움용. */
export async function GET() {
  try {
    const curve = await getTreasuryParYieldCurve();
    if (!curve) {
      return NextResponse.json(
        { error: "국채 수익률곡선을 불러오지 못했습니다." },
        { status: 502 }
      );
    }
    return NextResponse.json(curve);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "조회 실패" },
      { status: 502 }
    );
  }
}
