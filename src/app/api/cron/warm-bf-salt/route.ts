import { NextRequest, NextResponse } from "next/server";
import { getIssuers, getSalt } from "@/lib/server/boerseFrankfurt";
import { withLastGood } from "@/lib/server/redis";
import { getCompanies } from "@/lib/server/secEdgar";
import { getTreasuryList } from "@/lib/server/treasuryFiscalData";
import { getTreasuryParYieldCurve } from "@/lib/server/treasuryYieldCurve";

// 미국채 곡선 원본이 느리면(측정 19초) 여러 개를 합쳐 수십 초가 걸린다
export const maxDuration = 60;

/**
 * Vercel Cron(vercel.json)이 하루 1회 호출해 외부 원본 캐시를 Redis에 미리
 * 데워둔다. 처음엔 boerse-frankfurt salt만 데웠다(접속이 뜸해 캐시가 비면 그
 * 요청 하나가 홈페이지+메인 JS 번들 2MB대를 다시 받는 8초짜리 지연). 2026-10-14
 * 부터 미국채 곡선·미국 국채 목록·미국 기업 목록·프랑크푸르트 발행사 목록도 같이
 * 받고, 성공한 값은 마지막 정상값(withLastGood)으로도 남긴다 — 원본이 실패해도
 * 사용자 요청은 캐시나 저장본으로 바로 응답한다. 경로 이름은 vercel.json 호환을
 * 위해 그대로 둔다. CRON_SECRET 검증은 브라질 캐시 워밍과 동일하게 적용한다.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const nonEmpty = (v: unknown[]) => v.length > 0;
  const jobs: [string, () => Promise<unknown>][] = [
    ["salt", () => getSalt(true)],
    ["treasury-yield", async () => {
      if (!(await getTreasuryParYieldCurve())) throw new Error("곡선 없음");
    }],
    ["us-treasury-list", () => withLastGood("api:us-treasury-list", getTreasuryList, nonEmpty)],
    ["us-companies", () => withLastGood("api:us-companies", getCompanies, nonEmpty)],
    ["bond-issuers", () => withLastGood("api:bond-issuers", () => getIssuers(true), nonEmpty)],
  ];
  const settled = await Promise.allSettled(jobs.map(([, run]) => run()));
  const results = Object.fromEntries(
    settled.map((r, i) => [
      jobs[i][0],
      r.status === "fulfilled"
        ? "ok"
        : `error: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
    ])
  );
  const failed = settled.some((r) => r.status === "rejected");
  return NextResponse.json(
    { status: failed ? "partial" : "ok", results },
    { status: failed ? 502 : 200 }
  );
}
