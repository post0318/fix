import { getRedis } from "@/lib/server/redis";
import { isSettlementBusinessDay } from "@/lib/settlementCalendar";

const USER_AGENT =
  "ChaeGwonSesangBondApp research-contact@chaegwonsesang.example";
// 캐시는 시간(TTL)이 아니라 "재무부가 새 영업일 곡선을 발표했는가"로 판단한다
// (감사 Q4 — 예전엔 메모리 6h·Redis 24h TTL이라 한국 오전에 전날 곡선을 하루
// 늦게 쓰는 일이 있었다). 발표 시각 이후 아직 새 곡선이 안 올라온 경우(재무부
// 지연)에는 RETRY_MS 동안 재조회를 참아 요청이 몰리지 않게 한다.
const RETRY_MS = 30 * 60 * 1000;
const REDIS_KEY = "us-treasury-yield-curve-v1";
const REDIS_TTL_SECONDS = 24 * 60 * 60;
/** 재무부 일별 곡선 발표 시각(미 동부 15:30~16:00) 이후로 보는 기준 시(ET). */
const PUBLISH_HOUR_ET = 17;

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

/** now를 미 동부 시간으로 본 (연, 월, 일, 시). */
function easternParts(now: Date): { y: number; m: number; d: number; h: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") };
}

/**
 * 지금 시점에 재무부 사이트에 올라와 있어야 할 가장 최근 곡선 날짜(YYYY-MM-DD).
 * 동부시간 PUBLISH_HOUR_ET 이후면 오늘, 아니면 어제부터 거슬러 올라가 미국
 * 채권시장 영업일(주말·SIFMA 휴장일 제외)을 찾는다.
 */
export function latestPublishedCurveDate(now: Date = new Date()): string {
  const et = easternParts(now);
  const d = new Date(Date.UTC(et.y, et.m - 1, et.d));
  if (et.h < PUBLISH_HOUR_ET) d.setUTCDate(d.getUTCDate() - 1);
  while (!isSettlementBusinessDay(d, "US")) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 캐시된 곡선이 아직 최신인가 — 곡선 날짜가 발표됐어야 할 날짜 이상이면 최신. */
export function isCurveFresh(curve: TreasuryParYieldCurve, now: Date = new Date()): boolean {
  return curve.date >= latestPublishedCurveDate(now);
}

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
  const now = new Date();
  if (cached) {
    if (isCurveFresh(cached.curve, now)) return cached.curve;
    // 새 곡선이 나왔어야 하는데 아직 못 받은 상태 — 최근에 확인했으면 재시도를 미룬다.
    if (now.getTime() - cached.fetchedAt < RETRY_MS) return cached.curve;
  }

  const redis = getRedis();
  let fromRedis: TreasuryParYieldCurve | null = null;
  if (redis) {
    try {
      fromRedis = await redis.get<TreasuryParYieldCurve>(REDIS_KEY);
      if (fromRedis && isCurveFresh(fromRedis, now)) {
        cached = { curve: fromRedis, fetchedAt: now.getTime() };
        return fromRedis;
      }
    } catch {
      // Redis 조회 실패는 무시하고 원본 소스로 폴백한다.
    }
  }

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
  if (!curve) {
    // 원본 조회 실패 — 묵은 곡선이라도 있으면 그걸 쓴다(화면에 기준일이 표시됨).
    const fallback = cached?.curve ?? fromRedis;
    if (fallback) cached = { curve: fallback, fetchedAt: now.getTime() };
    return fallback;
  }

  // 재무부가 아직 새 날짜를 안 올렸으면(지연) 받은 곡선은 이전 날짜 그대로다 —
  // fetchedAt으로 RETRY_MS 동안 재조회를 막는다.
  cached = { curve, fetchedAt: now.getTime() };
  if (redis) {
    redis.set(REDIS_KEY, curve, { ex: REDIS_TTL_SECONDS }).catch(() => {});
  }
  return curve;
}

