import { CalcBasis, CouponFrequency } from "@/types/bondLayout";
import { isBrazilBusinessDay } from "@/lib/brazilCalendar";

const TRUST_MATURITY_LEAD_DAYS = 11;

export const FREQUENCY_MONTHS: Record<CouponFrequency, number> = {
  "3개월": 3,
  "6개월": 6,
  "12개월": 12,
};

/** PRICE 함수의 frequency 인자(1/2/4)로 변환 */
export const FREQUENCY_PER_YEAR: Record<CouponFrequency, number> = {
  "12개월": 1,
  "6개월": 2,
  "3개월": 4,
};

export function addMonths(date: Date, months: number): Date {
  const d = date.getUTCDate();
  // 목표 월의 1일로 옮긴 뒤, 그 달 마지막 날을 넘지 않게 clamp 한다.
  // (예: 8/31 − 6개월 → 2/31 이 setUTCMonth로는 3/3 으로 넘어가던 것 → 2/28.)
  //
  // EOM(월말) 규칙: 원래 날짜가 그 달 마지막 날이면 결과도 목표월 마지막 날로
  // 고정한다(엑셀 COUPPCD/COUPNCD·시장관행 — 미국 국채 2/28 만기 → 8/31·2/28
  // 이표, 11/30 만기 → 5/31·11/30). clamp만으로는 31일 만기에만 월말이 유지되고
  // 2/28·4/30·6/30·9/30·11/30 만기는 28·30일로 어긋났다(감사 F2). 윤년 2/28은
  // 월말이 아니므로(2/29가 있음) EOM으로 취급하지 않는다 — 관행과 일치.
  const sourceLastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const isEom = d === sourceLastDay;
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(isEom ? lastDay : Math.min(d, lastDay));
  return target;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * 결제일 계산.
 * - 브라질 국채(Business/252): SELIC 결제 관례대로 D+0. 신탁계약일이 브라질
 *   영업일(토/일 + ANBIMA/B3 국경일 제외)이면 그날, 아니면 다음 영업일.
 * - 그 외(한국/미국 등): 신탁계약일로부터 영업일(토/일 제외) 2일 후 (WORKDAY,
 *   공휴일 미반영).
 */
export function getSettlementDate(
  trustContractDate: string,
  calcBasis?: CalcBasis
): Date | null {
  const start = new Date(trustContractDate);
  if (Number.isNaN(start.getTime())) return null;

  if (calcBasis === "Business/252") {
    let date = start;
    while (!isBrazilBusinessDay(date)) date = addDays(date, 1);
    return date;
  }

  let date = start;
  let remaining = 2;
  while (remaining > 0) {
    date = addDays(date, 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining--;
  }
  return date;
}

export interface CouponPeriod {
  previousCouponDate: Date;
  nextCouponDate: Date;
  /** 결제일부터 만기일까지 남은 이표 횟수 (COUPNUM) */
  periodsRemaining: number;
}

/**
 * 만기일 기준으로 이자지급주기만큼씩 거슬러 올라가, 기준일이 속한 이표기간
 * (직전/차기 이표일)을 찾는다.
 *
 * 이표일은 항상 **만기일에서 months×k 개월** 뺀 날로 계산한다(연쇄로 이전
 * 결과에서 다시 빼면 2월을 지나며 월말성이 소실된다 — 8/31→2/28→8/28...).
 */
export function getCouponPeriod(
  maturity: Date,
  frequency: CouponFrequency,
  referenceDate: Date
): CouponPeriod {
  const months = FREQUENCY_MONTHS[frequency];
  let k = 1;
  let previousCouponDate = addMonths(maturity, -months * k);
  while (previousCouponDate > referenceDate) {
    k++;
    previousCouponDate = addMonths(maturity, -months * k);
  }
  const nextCouponDate = addMonths(maturity, -months * (k - 1));
  const periodsRemaining = k;

  return { previousCouponDate, nextCouponDate, periodsRemaining };
}

/**
 * 신탁만기 리드타임(일) = 신탁만기일 − 자산(채권) 만기일. 기본 11일이며,
 * 영업점이 신탁만기일을 수기로 고치면 그 차이일이 리드타임이 된다. 콜
 * 조기상환 시나리오에서는 이 차이일을 상환일에 그대로 적용한다(사용자 지시:
 * "자산만기와 신탁만기 간 차이일만큼") — override 날짜 자체를 만기 기준으로
 * 고정해 쓰던 것(Opus #4)도, 콜 시나리오에서 override를 무시하던 것도 아니다.
 */
export function getTrustMaturityLeadDays(
  assetMaturityDate: string,
  override?: string
): number {
  if (override && /^\d{1,4}-\d{2}-\d{2}$/.test(override)) {
    const overridden = new Date(override);
    const asset = new Date(assetMaturityDate);
    if (!Number.isNaN(overridden.getTime()) && !Number.isNaN(asset.getTime())) {
      return Math.round((overridden.getTime() - asset.getTime()) / MS_PER_DAY);
    }
  }
  return TRUST_MATURITY_LEAD_DAYS;
}

/**
 * 신탁만기일 = 실효 원금상환일(만기 또는 콜 상환일) + 리드타임.
 * `assetMaturityDate`를 생략하면 redemptionDate를 자산만기로 본다(만기보유) —
 * 이때 override가 있으면 결과는 override 그 자체(기존 동작과 동일).
 */
export function getTrustMaturityDate(
  redemptionDate: string,
  override?: string,
  assetMaturityDate?: string
): string | null {
  const base = new Date(redemptionDate);
  if (Number.isNaN(base.getTime())) return null;
  const lead = getTrustMaturityLeadDays(assetMaturityDate ?? redemptionDate, override);
  return toDateString(addDays(base, lead));
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** 투자일수 = 신탁만기일 - 신탁계약일 (일). override는 자산만기 대비 차이일로 반영. */
export function getInvestmentDays(
  trustContractDate: string,
  redemptionDate: string,
  trustMaturityOverride?: string,
  assetMaturityDate?: string
): number | null {
  const trustMaturity = getTrustMaturityDate(
    redemptionDate,
    trustMaturityOverride,
    assetMaturityDate
  );
  if (!trustMaturity) return null;

  const contract = new Date(trustContractDate);
  if (Number.isNaN(contract.getTime())) return null;

  const diff = new Date(trustMaturity).getTime() - contract.getTime();
  return Math.round(diff / MS_PER_DAY);
}

/** 최근이표일 = 만기일에서 이자지급주기만큼씩 거슬러 올라가 기준일(결제일) 이전인 가장 가까운 이표일 */
export function getRecentCouponDate(
  maturityDate: string,
  frequency: CouponFrequency,
  referenceDate: Date = new Date()
): string | null {
  const maturity = new Date(maturityDate);
  if (Number.isNaN(maturity.getTime())) return null;

  return toDateString(
    getCouponPeriod(maturity, frequency, referenceDate).previousCouponDate
  );
}

/** 이자계산일 목록. 신탁만기일(=만기일+11일)과 이자지급주기에 따라 행 수가 자동으로 변동한다. */
export function generateCouponSchedule(
  issueDate: string,
  maturityDate: string,
  frequency: CouponFrequency
): string[] {
  const issue = new Date(issueDate);
  const maturity = new Date(maturityDate);
  if (
    Number.isNaN(issue.getTime()) ||
    Number.isNaN(maturity.getTime()) ||
    maturity <= issue
  ) {
    return [];
  }

  const months = FREQUENCY_MONTHS[frequency];
  // 이표일은 만기일 기준으로 months×k 개월씩 뺀 날(월말성 유지). 발행일 이후
  // ~ 만기일 이전 구간만. 마지막 행은 신탁만기일(만기+11일).
  const coupons: Date[] = [];
  for (let k = 1; ; k++) {
    const d = addMonths(maturity, -months * k);
    if (d <= issue) break;
    coupons.unshift(d);
  }

  const dates = coupons.map(toDateString);
  dates.push(toDateString(addDays(maturity, TRUST_MATURITY_LEAD_DAYS)));

  return dates;
}
