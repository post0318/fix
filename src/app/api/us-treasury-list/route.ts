import { NextResponse } from "next/server";
import { getTreasuryList } from "@/lib/server/treasuryFiscalData";
import { withLastGood } from "@/lib/server/redis";

export async function GET() {
  try {
    // 원본 실패 시 마지막 정상값(staleSince = 저장 시각)
    const { value: bonds, staleSince } = await withLastGood("api:us-treasury-list", getTreasuryList, (v) => v.length > 0);
    return NextResponse.json({ bonds, staleSince });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "조회 실패" },
      { status: 502 }
    );
  }
}
