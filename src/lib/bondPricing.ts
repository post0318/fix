import { CalcBasis, CouponFrequency } from "@/types/bondLayout";
import {
  FREQUENCY_MONTHS,
  FREQUENCY_PER_YEAR,
  addMonths,
  getCouponPeriod,
  getSettlementDate,
} from "@/lib/couponSchedule";
import { brazilBusinessDaysBetween } from "@/lib/brazilCalendar";

export const BASIS_INDEX: Record<CalcBasis, number> = {
  "미국 30/360": 0,
  "ACT/ACT": 1,
  "ACT/360": 2,
  "ACT/365": 3,
  "유럽 30/360": 4,
  "Business/252": 5,
};

function actualDays(start: Date, end: Date): number {
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  return Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
}

/** 그 해·그 달 기준 2월 말일(윤년 29·평년 28)인가 */
function isLastDayOfFeb(year: number, month: number, day: number): boolean {
  return month === 2 && day === (isLeapYear(year) ? 29 : 28);
}

/**
 * 30/360 (미국 NASD/SIA) 방식 일수. 엑셀 `YEARFRAC(…,0)`·`PRICE`와 동일한
 * 순서로 보정한다:
 *  ① D1·D2 모두 2월 말일이면 D2 = 30
 *  ② D1이 2월 말일이면 D1 = 30
 *  ③ D1 = 31이면 D1 = 30
 *  ④ D2 = 31이고 (보정 후) D1 = 30이면 D2 = 30
 */
function days360Us(start: Date, end: Date): number {
  const y1 = start.getUTCFullYear();
  const m1 = start.getUTCMonth() + 1;
  let d1 = start.getUTCDate();
  const y2 = end.getUTCFullYear();
  const m2 = end.getUTCMonth() + 1;
  let d2 = end.getUTCDate();

  const d1IsFebEnd = isLastDayOfFeb(y1, m1, d1);
  if (d1IsFebEnd && isLastDayOfFeb(y2, m2, d2)) d2 = 30;
  if (d1IsFebEnd) d1 = 30;
  if (d1 === 31) d1 = 30;
  if (d2 === 31 && d1 === 30) d2 = 30;

  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
}

/** 30/360 (유럽) 방식 일수 */
function days360Eu(start: Date, end: Date): number {
  const y1 = start.getUTCFullYear();
  const m1 = start.getUTCMonth() + 1;
  const d1 = Math.min(start.getUTCDate(), 30);
  const y2 = end.getUTCFullYear();
  const m2 = end.getUTCMonth() + 1;
  const d2 = Math.min(end.getUTCDate(), 30);

  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** ACT/ACT: 같은 해에 속하면 실제일수/해당 연도 일수(365 또는 366), 해를 걸치면 각 해 구간을 나눠 합산 */
function yearFracActAct(start: Date, end: Date): number {
  let s = start;
  let e = end;
  let sign = 1;
  if (s > e) {
    [s, e] = [e, s];
    sign = -1;
  }

  const y1 = s.getUTCFullYear();
  const y2 = e.getUTCFullYear();

  if (y1 === y2) {
    return (sign * actualDays(s, e)) / (isLeapYear(y1) ? 366 : 365);
  }

  let sum = 0;
  const endOfY1 = new Date(Date.UTC(y1, 11, 31));
  sum += (actualDays(s, endOfY1) + 1) / (isLeapYear(y1) ? 366 : 365);

  for (let y = y1 + 1; y < y2; y++) {
    sum += 1;
  }

  const startOfY2 = new Date(Date.UTC(y2, 0, 1));
  sum += actualDays(startOfY2, e) / (isLeapYear(y2) ? 366 : 365);

  return sign * sum;
}

/** YEARFRAC(start, end, basis) 근사 구현. basis: 0=미국30/360, 1=ACT/ACT, 2=ACT/360, 3=ACT/365, 4=유럽30/360, 5=Business/252(브라질) */
export function yearFrac(start: Date, end: Date, basis: number): number {
  switch (basis) {
    case 0:
      return days360Us(start, end) / 360;
    case 2:
      return actualDays(start, end) / 360;
    case 3:
      return actualDays(start, end) / 365;
    case 4:
      return days360Eu(start, end) / 360;
    case 5:
      return brazilBusinessDaysBetween(start, end) / 252;
    case 1:
    default:
      return yearFracActAct(start, end);
  }
}

export function roundDown(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.trunc(value * factor) / factor;
}

export function roundUp(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return (Math.sign(value) || 1) * Math.ceil(Math.abs(value) * factor) / factor;
}

/**
 * 반기(등) 실효 표면이율 계수 [(1+연이율)^(1/periods) − 1].
 * ANBIMA "Caderno de Fórmulas — NTN-F"대로 백분율 기준 소수 6자리 반올림한다
 * (연 10% → 반기 4.880885% → per 1,000 face 48.80885). 블룸버그 실측과 대조 확인.
 */
export function anbimaCouponFactor(
  annualRateDec: number,
  periodsPerYear: number
): number {
  return (
    Math.round((Math.pow(1 + annualRateDec, 1 / periodsPerYear) - 1) * 1e8) / 1e8
  );
}

/** ANBIMA: 브라질 국채 PU는 소수 6자리 절사(truncamento). */
export function truncPu(value: number): number {
  return Math.trunc(value * 1e6) / 1e6;
}

/**
 * 경과이자(juros decorridos). 브라질(Business/252)은 ANBIMA 관행대로 복리
 * VN×((1+표면금리)^(경과영업일/252)−1), 그 외 관행은 표면금리×경과연수(단리).
 */
function accruedInterestFor(
  notional: number,
  couponRateDec: number,
  accrualFrac: number,
  isBrazil: boolean
): number {
  return isBrazil
    ? notional * (Math.pow(1 + couponRateDec, accrualFrac) - 1)
    : notional * couponRateDec * accrualFrac;
}

/**
 * 채권 매수단가(clean, per `redemption` face — 국내 원화채권은 10,000, 그 외는
 * 국제 관행대로 100).
 *
 * `actualDayCount=false`(기본): fix.xlsx의 `PRICE(...)` 호출대로 미국 30/360으로
 * 이표기간 분율(E·DSC·A)을 계산한다.
 * `actualDayCount=true`(ACT/ACT): 이표기간 분율을 실제일수로 계산한다 —
 * ICMA(ISMA) 관행이자 엑셀 `PRICE(...,1)` 의 내부 계산 기준.
 */
export function computeCleanPrice(
  settlement: Date,
  maturity: Date,
  annualRate: number,
  annualYield: number,
  redemption: number,
  frequency: CouponFrequency,
  actualDayCount = false
): number | null {
  if (settlement >= maturity) return null;

  const f = FREQUENCY_PER_YEAR[frequency];
  const { previousCouponDate, nextCouponDate, periodsRemaining } =
    getCouponPeriod(maturity, frequency, settlement);

  const dc = actualDayCount ? actualDays : days360Us;
  const e = dc(previousCouponDate, nextCouponDate);
  const dsc = dc(settlement, nextCouponDate);
  const a = dc(previousCouponDate, settlement);
  if (e === 0) return null;

  const coupon = (redemption * annualRate) / f;
  const yieldPerPeriod = annualYield / f;
  const n = periodsRemaining;

  if (n === 1) {
    return (
      (redemption + coupon) / (1 + (dsc / e) * yieldPerPeriod) -
      coupon * (a / e)
    );
  }

  let sum = 0;
  for (let k = 1; k <= n; k++) {
    sum += coupon / Math.pow(1 + yieldPerPeriod, k - 1 + dsc / e);
  }

  return (
    redemption / Math.pow(1 + yieldPerPeriod, n - 1 + dsc / e) +
    sum -
    coupon * (a / e)
  );
}

/**
 * computeCleanPrice의 역산(가격→수익률). 가격은 수익률에 대해 단조감소이므로
 * 이분탐색으로 목표가(clean price)에 대응하는 연수익률을 찾는다. 종목검색
 * (Frankfurt) 상세조회에서 lastPrice만 주고 수익률은 안 줄 때, 이 앱의
 * 기본 날짜계산기준(미국 30/360 — computeCleanPrice 자체가 이 기준 고정)과
 * 기본 이자지급주기(6개월)를 가정해 근사 수익률을 구하는 용도. 실제 채권의
 * 날짜계산기준/주기가 다르면 오차가 있을 수 있는 추정치다.
 */
export function impliedYieldFromPrice(
  settlement: Date,
  maturity: Date,
  annualRate: number,
  targetPrice: number,
  redemption: number,
  frequency: CouponFrequency
): number | null {
  if (settlement >= maturity) return null;

  let lo = -0.5;
  let hi = 2;
  const priceAt = (y: number) =>
    computeCleanPrice(settlement, maturity, annualRate, y, redemption, frequency);

  const priceLo = priceAt(lo);
  const priceHi = priceAt(hi);
  if (priceLo === null || priceHi === null) return null;
  if (!(priceLo >= targetPrice && targetPrice >= priceHi)) return null;

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const priceMid = priceAt(mid);
    if (priceMid === null) return null;
    if (priceMid > targetPrice) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/** settlement 이후 다음 이표일부터 만기까지의 명목상(달력) 이표일 목록 */
function brazilCouponDates(
  settlement: Date,
  maturity: Date,
  frequency: CouponFrequency
): Date[] {
  const months = FREQUENCY_MONTHS[frequency];
  const dates: Date[] = [];
  let cursor = maturity;
  while (cursor > settlement) {
    dates.unshift(cursor);
    cursor = addMonths(cursor, -months);
  }
  return dates;
}

/**
 * 브라질 국채(NTN-F 등, Business/252) 전용 가격(=결제금액/dirty price) 계산.
 * 미국식 PRICE() 공식(days360Us 기반)과는 근본적으로 다른 ANBIMA 표준 공식을
 * 쓴다: 표면금리를 복리로 환산한 반기 실효쿠폰(예: 연 10% -> 반기 4.880885%,
 * "6개월마다 복리 환산 이자 지급")을 지급하고, 결제일부터 각 현금흐름까지의
 * 영업일수(Business/252)를 지수로 한 복리로 할인한다: PU = Σ CF/(1+수익률)^(영업일수/252).
 * 블룸버그 실제 값(NTN-F 2037, 수익률 14%, 2026-08-27 결제)과 대조해 0.04%
 * 이내로 일치함을 확인했다. computeCleanPrice(엑셀 PRICE 방식)를 그대로 쓰면
 * 이 특성을 반영하지 못해 3~5% 오차가 난다.
 */
export function computeBrazilDirtyPrice(
  settlement: Date,
  maturity: Date,
  annualRate: number,
  annualYield: number,
  redemption: number,
  frequency: CouponFrequency
): number | null {
  if (settlement >= maturity) return null;

  const f = FREQUENCY_PER_YEAR[frequency];
  const coupon = redemption * anbimaCouponFactor(annualRate, f);
  const dates = brazilCouponDates(settlement, maturity, frequency);
  if (dates.length === 0) return null;

  let pv = 0;
  for (const date of dates) {
    const isMaturity = date.getTime() === maturity.getTime();
    const cashFlow = coupon + (isMaturity ? redemption : 0);
    const businessDays = brazilBusinessDaysBetween(settlement, date);
    pv += cashFlow / Math.pow(1 + annualYield, businessDays / 252);
  }
  return pv;
}

export interface BondPricingInputs {
  maturityDate: string;
  couponRate: string; // %
  couponFrequency: CouponFrequency;
  purchaseYield: string; // %
  calcBasis: CalcBasis;
  trustContractDate: string;
  recentCouponDate: string;
  tradeCurrency: string;
  custodyCurrency: string;
  purchaseFxRate: string;
  trustInvestmentAmount: string;
  frontFeeRate: string;
}

export interface BondPricingResult {
  settlementDate: string;
  recentCouponDate: string;
  accrualFraction: number;
  cleanPrice: number;
  dirtyPrice: number;
  faceValue: number;
  accruedInterest: number;
  settlementAmount: number;
  cashBalance: number;
}

/** 채권권면액/매수단가(clean·dirty)/경과이자/결제금액/현금잔액을 fix.xlsx 수식과 동일한 순서로 계산한다 */
export function computeBondPricing(
  input: BondPricingInputs
): BondPricingResult | null {
  const maturity = new Date(input.maturityDate);
  const rate = Number(input.couponRate);
  const yld = Number(input.purchaseYield);
  const principal = Number(input.trustInvestmentAmount);
  const frontFeeRate = Number(input.frontFeeRate);

  if (
    Number.isNaN(maturity.getTime()) ||
    Number.isNaN(rate) ||
    Number.isNaN(yld) ||
    !input.trustInvestmentAmount ||
    Number.isNaN(principal) ||
    !input.frontFeeRate ||
    Number.isNaN(frontFeeRate)
  ) {
    return null;
  }

  const settlement = getSettlementDate(input.trustContractDate, input.calcBasis);
  if (!settlement) return null;

  // 국내 원화채권은 액면 10,000원당, 브라질 국채(ANBIMA 관행)는 액면 1,000당,
  // 그 외는 국제 관행대로 액면 100당 가격으로 계산한다.
  const isBrazil = input.calcBasis === "Business/252";
  const redemptionBasis = isBrazil ? 1000 : input.tradeCurrency === "KRW" ? 10000 : 100;

  const period = getCouponPeriod(maturity, input.couponFrequency, settlement);
  const recentCoupon = input.recentCouponDate
    ? new Date(input.recentCouponDate)
    : period.previousCouponDate;

  const basis = BASIS_INDEX[input.calcBasis];
  const isActAct = input.calcBasis === "ACT/ACT";
  // ACT/ACT는 ICMA(ISMA) 관행으로 일원화 — 경과분율 = (직전이표일→결제일 실제
  // 일수) ÷ (그 이표기간 실제일수) ÷ 연간지급횟수. 엑셀 PRICE(...,1)의 내부 할인·
  // 경과 계산과 같은 기준이라 YEARFRAC(...,1)(ISDA 연도분할)보다 정합적이다.
  const accrualFrac = isActAct
    ? actualDays(period.previousCouponDate, settlement) /
      actualDays(period.previousCouponDate, period.nextCouponDate) /
      FREQUENCY_PER_YEAR[input.couponFrequency]
    : yearFrac(recentCoupon, settlement, basis);

  let cleanPrice: number;
  let dirtyPrice: number;

  if (isBrazil) {
    const dirtyRaw = computeBrazilDirtyPrice(
      settlement,
      maturity,
      rate / 100,
      yld / 100,
      redemptionBasis,
      input.couponFrequency
    );
    if (dirtyRaw === null) return null;
    dirtyPrice = truncPu(dirtyRaw);
    cleanPrice = truncPu(
      dirtyPrice - accruedInterestFor(redemptionBasis, rate / 100, accrualFrac, true)
    );
  } else {
    const cleanRaw = computeCleanPrice(
      settlement,
      maturity,
      rate / 100,
      yld / 100,
      redemptionBasis,
      input.couponFrequency,
      isActAct
    );
    if (cleanRaw === null) return null;
    cleanPrice = roundUp(cleanRaw, 4);
    dirtyPrice = roundUp(
      cleanPrice + accruedInterestFor(redemptionBasis, rate / 100, accrualFrac, false),
      4
    );
  }

  const needsFx = input.tradeCurrency !== input.custodyCurrency;
  const fxRate = needsFx ? Number(input.purchaseFxRate) : 1;
  if (needsFx && (!fxRate || Number.isNaN(fxRate) || fxRate <= 0)) return null;

  const frontFeeAmount = Math.trunc(principal * (frontFeeRate / 100));
  const availableAmount = principal - frontFeeAmount;

  const faceValue = roundDown(
    (availableAmount / fxRate / dirtyPrice) * redemptionBasis,
    -3
  );

  const accruedInterest = accruedInterestFor(
    faceValue,
    rate / 100,
    accrualFrac,
    isBrazil
  );
  const settlementAmountRaw = (faceValue * dirtyPrice) / redemptionBasis * fxRate;
  // 화면에 보이는 결제금액(수탁통화 KRW는 정수 절사, 그 외는 소수점 2자리
  // 절사)과 실제로 현금잔액 계산에 쓰는 값이 달라서
  // "매수가능금액-결제금액≠현금잔액"으로 보이던 문제가 있었다. 표시값과
  // 동일하게 미리 절사해 일치시킨다.
  const isKrwSettlement = input.custodyCurrency === "KRW";
  const settlementAmount = isKrwSettlement
    ? Math.trunc(settlementAmountRaw)
    : roundDown(settlementAmountRaw, 2);
  const cashBalance = roundDown(principal - frontFeeAmount - settlementAmount, 2);

  return {
    settlementDate: settlement.toISOString().slice(0, 10),
    recentCouponDate: recentCoupon.toISOString().slice(0, 10),
    accrualFraction: accrualFrac,
    cleanPrice,
    dirtyPrice,
    faceValue,
    accruedInterest,
    settlementAmount,
    cashBalance,
  };
}
