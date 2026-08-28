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
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
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
    const day = date.getDay();
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

/** 만기일을 기준으로 이자지급주기만큼씩 거슬러 올라가, 기준일이 속한 이표기간(직전/차기 이표일)을 찾는다 */
export function getCouponPeriod(
  maturity: Date,
  frequency: CouponFrequency,
  referenceDate: Date
): CouponPeriod {
  const months = FREQUENCY_MONTHS[frequency];
  let nextCouponDate = maturity;
  let previousCouponDate = addMonths(nextCouponDate, -months);
  let periodsRemaining = 1;

  while (previousCouponDate > referenceDate) {
    nextCouponDate = previousCouponDate;
    previousCouponDate = addMonths(nextCouponDate, -months);
    periodsRemaining++;
  }

  return { previousCouponDate, nextCouponDate, periodsRemaining };
}

export function getTrustMaturityDate(maturityDate: string): string | null {
  const maturity = new Date(maturityDate);
  if (Number.isNaN(maturity.getTime())) return null;
  return toDateString(addDays(maturity, TRUST_MATURITY_LEAD_DAYS));
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** 투자일수 = 신탁만기일 - 신탁계약일 (일) */
export function getInvestmentDays(
  trustContractDate: string,
  maturityDate: string
): number | null {
  const trustMaturity = getTrustMaturityDate(maturityDate);
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
  const dates: string[] = [];
  let next = addMonths(issue, months);

  while (next < maturity) {
    dates.push(toDateString(next));
    next = addMonths(next, months);
  }

  dates.push(toDateString(addDays(maturity, TRUST_MATURITY_LEAD_DAYS)));

  return dates;
}
