import { NextRequest, NextResponse } from "next/server";
import { getYieldEstimateByIsin } from "@/lib/server/boerseFrankfurt";

/**
 * 미국채권검색(SEC EDGAR 회사채/미국국채)의 매수금리를 boerse-frankfurt
 * 현재가 기반 추정치로 채운다. 표면이율/만기일은 fiscaldata.treasury.gov나
 * SEC EDGAR에서 이미 알고 있는 값을 그대로 넘겨받아 쓴다(boerse-frankfurt
 * 자체 master_data_bond의 표면이율 필드는 국채에서 비어있는 경우가 있어
 * 신뢰하지 않는다).
 */
export async function GET(request: NextRequest) {
  const isin = request.nextUrl.searchParams.get("isin");
  const couponRate = Number(request.nextUrl.searchParams.get("couponRate"));
  const maturityDate = request.nextUrl.searchParams.get("maturityDate");
  const freqRaw = Number(request.nextUrl.searchParams.get("freqMonths"));
  const freqMonths = [3, 6, 12].includes(freqRaw) ? freqRaw : null;
  if (!isin || !maturityDate || Number.isNaN(couponRate)) {
    return NextResponse.json(
      { error: "isin/couponRate/maturityDate 파라미터가 필요합니다." },
      { status: 400 }
    );
  }
  try {
    const rate = await getYieldEstimateByIsin(
      isin,
      couponRate,
      maturityDate,
      freqMonths
    );
    return NextResponse.json({ rate });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "조회 실패" },
      { status: 502 }
    );
  }
}
