import { CalcBasis, CallScenario, CouponFrequency } from "@/types/bondLayout";
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
 * 이표기간 분율(E·DSC·A)을 `basis`(BASIS_INDEX 값)에 맞춰 엑셀 `PRICE(…, basis)`
 * 와 동일하게 산정한다:
 *  - 0 미국 30/360 : E·DSC·A 모두 30/360 US
 *  - 4 유럽 30/360 : E·DSC·A 모두 30E/360
 *  - 1 ACT/ACT     : E·DSC·A 모두 실제일수 (ICMA/ISMA)
 *  - 2 ACT/360     : E = 360/f, DSC·A = 실제일수
 *  - 3 ACT/365     : E = 365/f, DSC·A = 실제일수
 */
export function computeCleanPrice(
  settlement: Date,
  maturity: Date,
  annualRate: number,
  annualYield: number,
  redemption: number,
  frequency: CouponFrequency,
  basis = 0
): number | null {
  if (settlement >= maturity) return null;

  const f = FREQUENCY_PER_YEAR[frequency];
  const { previousCouponDate, nextCouponDate, periodsRemaining } =
    getCouponPeriod(maturity, frequency, settlement);

  let e: number;
  let dsc: number;
  let a: number;
  if (basis === 4) {
    e = days360Eu(previousCouponDate, nextCouponDate);
    dsc = days360Eu(settlement, nextCouponDate);
    a = days360Eu(previousCouponDate, settlement);
  } else if (basis === 1) {
    e = actualDays(previousCouponDate, nextCouponDate);
    dsc = actualDays(settlement, nextCouponDate);
    a = actualDays(previousCouponDate, settlement);
  } else if (basis === 2 || basis === 3) {
    e = (basis === 3 ? 365 : 360) / f;
    dsc = actualDays(settlement, nextCouponDate);
    a = actualDays(previousCouponDate, settlement);
  } else {
    e = days360Us(previousCouponDate, nextCouponDate);
    dsc = days360Us(settlement, nextCouponDate);
    a = days360Us(previousCouponDate, settlement);
  }
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
 * (Frankfurt) 상세조회에서 lastPrice만 주고 수익률은 안 줄 때 쓴다.
 *
 * 날짜계산기준은 미국 30/360으로 가정한다 — `computeCleanPrice`는 basis
 * 인자를 받지만 여기선 넘기지 않는다(호출부가 Frankfurt에서 실제 basis를
 * 확인할 수 없어서). 미국채(ACT/ACT)는 이 가정으로 인한 오차가 ≤0.02bp로
 * 무시할 수준. 이자지급주기는 호출부가 알면 그 값(frequency), 모르면 6개월을
 * 넘긴다. 실무상 추정치이며 화면에도 그렇게 표시된다.
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
  // 이표일은 만기일 기준 months×k 개월(월말성 유지 — 연쇄 계산은 2월에서
  // 월말성이 깨진다). settlement 이후 만기일까지.
  const dates: Date[] = [maturity];
  for (let k = 1; ; k++) {
    const d = addMonths(maturity, -months * k);
    if (d <= settlement) break;
    dates.unshift(d);
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
  // 경과분율은 basis별로 computeCleanPrice의 내부 경과분(coupon·a/e)과 같은
  // 기준이라야 clean+경과=dirty 검산이 맞는다. ACT/ACT만 ICMA(쿠폰기간 분율 ÷
  // 지급횟수)로 별도 계산 — YEARFRAC(...,1)(ISDA 연도분할)은 엑셀 PRICE(...,1)과
  // 어긋난다. 나머지(30/360 US·EU, ACT/360, ACT/365)는 yearFrac이 이미 맞다.
  const accrualFrac =
    basis === 1
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
      basis
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

/**
 * make-whole 상환가(clean price, per `redemptionBasis` 액면).
 * 프로스펙터스 관행: "greater of (1) 100% of principal, (2) 잔여 예정
 * 원리금을 (기준 국채금리 + 스프레드)로 할인한 값(less accrued)". 여기서는
 * 엑셀 PRICE 방식(computeCleanPrice)으로 (2)의 clean price를 구해 액면과
 * 비교한다. 결과는 참고용 추정치다 — 실제 make-whole 금리는 상환통지 시점의
 * H.15 CMT(잔존만기 보간)를 쓴다.
 */
export function computeMakeWholePrice(
  redemptionDate: Date,
  maturity: Date,
  annualRate: number,
  refYield: number,
  spreadBps: number,
  redemptionBasis: number,
  frequency: CouponFrequency,
  basis = 0
): number | null {
  if (redemptionDate >= maturity) return null;
  if (Number.isNaN(refYield) || Number.isNaN(spreadBps)) return null;
  const discountYield = refYield + spreadBps / 10000;
  const clean = computeCleanPrice(
    redemptionDate,
    maturity,
    annualRate,
    discountYield,
    redemptionBasis,
    frequency,
    basis
  );
  if (clean === null) return null;
  return Math.max(redemptionBasis, clean);
}

export interface EffectiveRedemptionInput {
  hasCall: boolean;
  callScenario: CallScenario;
  maturityDate: string;
  parCallDate: string;
  makeWholeRedemptionDate: string;
  makeWholeRefYield: string; // %
  makeWholeSpreadBps: string; // bp
  couponRate: string; // %
  couponFrequency: CouponFrequency;
  calcBasis: CalcBasis;
  tradeCurrency: string;
  /** 상환일 하한 검증(결제일 이후여야 함)에 쓰인다. */
  trustContractDate: string;
  /** 풋옵션(투자자 조기상환청구권) 존재 여부. */
  hasPut: boolean;
  /** 풋옵션 행사일(YYYY-MM-DD). 상환가는 액면(100%) 고정 가정. */
  putDate: string;
}

/**
 * make-whole 상환가 계산의 PV 지평(="만기"로 가정하는 날짜). 프로스펙터스
 * 표준 문구("assuming that such notes matured on the Par Call Date")대로,
 * par call일이 상환일보다 뒤이고 실제 만기 이전이면 그 날짜를 쓰고, 아니면
 * 실제 만기를 쓴다(감사 #2 — 만기까지 통째로 할인하면 프리미엄이 체계적으로
 * 과대해짐). par call일이 실제 이표 그리드와 어긋나 있어도(예: "만기 1개월
 * 전") 그대로 지평으로 쓰는 근사치다 — 참고용 추정임을 전제한다.
 */
export function getMakeWholeDiscountHorizon(
  maturityDate: string,
  parCallDate: string,
  redemptionDate: string
): string {
  if (!parCallDate) return maturityDate;
  const maturity = new Date(maturityDate);
  const parCall = new Date(parCallDate);
  const redemption = new Date(redemptionDate);
  if (
    Number.isNaN(maturity.getTime()) ||
    Number.isNaN(parCall.getTime()) ||
    Number.isNaN(redemption.getTime())
  ) {
    return maturityDate;
  }
  return parCall > redemption && parCall <= maturity ? parCallDate : maturityDate;
}

export interface EffectiveRedemption {
  /** 실제 원금상환일 (YYYY-MM-DD) */
  redemptionDate: string;
  /** 원금상환 배수 (1 = 액면, >1 = make-whole 프리미엄) */
  redemptionPriceFactor: number;
  /** make-whole 상환가 (per 100 액면). 시나리오가 makeWhole이고 계산 가능할 때만. */
  makeWholePricePer100: number | null;
  /** 실제로 적용된 시나리오. 입력이 불완전하면 "hold"로 폴백한다. */
  applied: CallScenario;
}

/**
 * 콜 시나리오에 따른 실효 원금상환일·상환배수를 구한다. hasCall=false거나
 * 시나리오 입력(날짜·금리 등)이 불완전하면 만기보유(hold)로 폴백한다.
 * 매수 시점 계산(computeBondPricing)에는 영향을 주지 않고, 현금흐름·수익률
 * 산출에만 쓰인다.
 */
export function getEffectiveRedemption(
  input: EffectiveRedemptionInput
): EffectiveRedemption {
  const hold: EffectiveRedemption = {
    redemptionDate: input.maturityDate,
    redemptionPriceFactor: 1,
    makeWholePricePer100: null,
    applied: "hold",
  };

  const maturity = new Date(input.maturityDate);
  if (Number.isNaN(maturity.getTime())) return hold;
  if (input.callScenario === "hold") return hold;

  // 상환일 하한 = 결제일. 하한 미검증이면 과거 콜/풋일 입력 시 음수 이자·음수
  // 투자일수가 나온다(감사 #3). 결제일을 못 구하면 검증 없이 인정하지 않고
  // hold로 폴백한다.
  const settlement = getSettlementDate(input.trustContractDate, input.calcBasis);
  if (!settlement) return hold;

  if (input.callScenario === "parCall") {
    if (!input.hasCall) return hold;
    const d = new Date(input.parCallDate);
    if (Number.isNaN(d.getTime()) || d >= maturity || d <= settlement) return hold;
    return {
      redemptionDate: input.parCallDate,
      redemptionPriceFactor: 1,
      makeWholePricePer100: null,
      applied: "parCall",
    };
  }

  if (input.callScenario === "put") {
    // 풋옵션(투자자 조기상환청구권) 행사 — par call과 동일하게 액면(100%) 상환.
    if (!input.hasPut) return hold;
    const d = new Date(input.putDate);
    if (Number.isNaN(d.getTime()) || d >= maturity || d <= settlement) return hold;
    return {
      redemptionDate: input.putDate,
      redemptionPriceFactor: 1,
      makeWholePricePer100: null,
      applied: "put",
    };
  }

  // makeWhole
  if (!input.hasCall) return hold;
  const d = new Date(input.makeWholeRedemptionDate);
  const refYield = Number(input.makeWholeRefYield);
  const spreadBps = Number(input.makeWholeSpreadBps);
  const rate = Number(input.couponRate);
  if (
    Number.isNaN(d.getTime()) ||
    d >= maturity ||
    d <= settlement ||
    !input.makeWholeRefYield ||
    Number.isNaN(refYield) ||
    !input.makeWholeSpreadBps ||
    Number.isNaN(spreadBps) ||
    Number.isNaN(rate)
  ) {
    return hold;
  }

  const isBrazil = input.calcBasis === "Business/252";
  const redemptionBasis = isBrazil
    ? 1000
    : input.tradeCurrency === "KRW"
      ? 10000
      : 100;

  // 상환일이 par call일 이후면 par call 기간이라 make-whole 프리미엄 없이
  // 액면(100%) 상환이다(감사 F6 — 이전엔 만기까지 할인해 100.277 같은
  // 프리미엄이 나왔다). 시나리오 표시는 makeWhole로 유지하되 상환가 100.
  if (input.parCallDate) {
    const parCall = new Date(input.parCallDate);
    if (!Number.isNaN(parCall.getTime()) && d >= parCall) {
      return {
        redemptionDate: input.makeWholeRedemptionDate,
        redemptionPriceFactor: 1,
        makeWholePricePer100: 100,
        applied: "makeWhole",
      };
    }
  }

  // PV 지평은 par call일이 있으면 그 날을 "만기"로 가정한다(감사 #2).
  const horizon = new Date(
    getMakeWholeDiscountHorizon(
      input.maturityDate,
      input.parCallDate,
      input.makeWholeRedemptionDate
    )
  );
  const price = computeMakeWholePrice(
    d,
    horizon,
    rate / 100,
    refYield / 100,
    spreadBps,
    redemptionBasis,
    input.couponFrequency,
    BASIS_INDEX[input.calcBasis]
  );
  if (price === null) return hold;

  return {
    redemptionDate: input.makeWholeRedemptionDate,
    redemptionPriceFactor: price / redemptionBasis,
    makeWholePricePer100: (price / redemptionBasis) * 100,
    applied: "makeWhole",
  };
}
