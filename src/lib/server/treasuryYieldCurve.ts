import { getRedis } from "@/lib/server/redis";

const USER_AGENT =
  "ChaeGwonSesangBondApp research-contact@chaegwonsesang.example";
const TTL_MS = 6 * 60 * 60 * 1000;
const REDIS_KEY = "us-treasury-yield-curve-v1";
const REDIS_TTL_SECONDS = 24 * 60 * 60;

// 타입·보간은 클라이언트와 공유하는 순수 모듈(@/lib/yieldCurve)에 있다.
import type { TreasuryParYieldCurve, YieldCurvePoint } from "@/lib/yieldCurve";
export type { TreasuryParYieldCurve, YieldCurvePoint } from "@/lib/yieldCurve";

// XML의 <d:BC_*> 필드 → 만기(연). BC_30YEARDISPLAY 등 표시용 필드는 제외.
const TENOR_YEARS: Record<string, number> = {
  BC_1MONTH: 1 / 12,
  BC_1_5MONTH: 1.5 / 12,
  BC_2MONTH: 2 / 12,
  BC_3MONTH: 3 / 12,
  BC_4MONTH: 4 / 12,
  BC_6MONTH: 0.5,
  BC_1YEAR: 1,
  BC_2YEAR: 2,
  BC_3YEAR: 3,
  BC_5YEAR: 5,
  BC_7YEAR: 7,
  BC_10YEAR: 10,
  BC_20YEAR: 20,
  BC_30YEAR: 30,
};

let cached: { curve: TreasuryParYieldCurve; fetchedAt: number } | null = null;

function monthParam(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function feedUrl(yyyymm: string): string {
  return `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${yyyymm}`;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Treasury yield 요청 실패 (${res.status})`);
  return res.text();
}

/**
 * Atom XML 피드에서 가장 최근 <entry>(= 최신 영업일)를 골라 테너별 금리를
 * 뽑는다. 엔트리는 날짜 오름차순이라 마지막 유효 엔트리가 최신이다.
 */
function parseCurve(xml: string): TreasuryParYieldCurve | null {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(
    (m) => m[1]
  );
  for (let i = entries.length - 1; i >= 0; i--) {
    const block = entries[i];
    const dateMatch = block.match(
      /<d:NEW_DATE[^>]*>(\d{4}-\d{2}-\d{2})/
    );
    if (!dateMatch) continue;

    const points: YieldCurvePoint[] = [];
    for (const [field, years] of Object.entries(TENOR_YEARS)) {
      const re = new RegExp(`<d:${field}[^>]*>([\\d.\\-]+)<`);
      const m = block.match(re);
      if (!m) continue;
      const rate = Number(m[1]);
      if (!Number.isFinite(rate)) continue;
      points.push({ years, rate });
    }
    if (points.length < 3) continue;
    points.sort((a, b) => a.years - b.years);
    return { date: dateMatch[1], points };
  }
  return null;
}

/**
 * 미 재무부(home.treasury.gov, 공식·무료·키 불필요) 일별 국채 par yield
 * curve의 최신값. 월초엔 이번 달 데이터가 없을 수 있어 직전 달도 시도한다.
 * treasuryFiscalData와 동일하게 Redis에도 캐시한다.
 */
export async function getTreasuryParYieldCurve(): Promise<TreasuryParYieldCurve | null> {
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.curve;

  const redis = getRedis();
  if (redis) {
    try {
      const fromRedis = await redis.get<TreasuryParYieldCurve>(REDIS_KEY);
      if (fromRedis) {
        cached = { curve: fromRedis, fetchedAt: Date.now() };
        return fromRedis;
      }
    } catch {
      // Redis 조회 실패는 무시하고 원본 소스로 폴백한다.
    }
  }

  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  let curve: TreasuryParYieldCurve | null = null;
  for (const yyyymm of [monthParam(now), monthParam(prev)]) {
    try {
      curve = parseCurve(await fetchText(feedUrl(yyyymm)));
      if (curve) break;
    } catch {
      // 다음 달로 폴백
    }
  }
  if (!curve) return null;

  cached = { curve, fetchedAt: Date.now() };
  if (redis) {
    redis.set(REDIS_KEY, curve, { ex: REDIS_TTL_SECONDS }).catch(() => {});
  }
  return curve;
}

