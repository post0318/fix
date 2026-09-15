import {
  CallScenario,
  CouponFrequency,
  Currency,
  InvestorType,
  CalcBasis,
  TaxStatus,
} from "@/types/bondLayout";
import { FREQUENCY_MONTHS, addMonths } from "@/lib/couponSchedule";
import {
  BASIS_INDEX,
  computeBondPricing,
  getEffectiveRedemption,
  roundDown,
  yearFrac,
} from "@/lib/bondPricing";
import { computeWithholdingTax } from "@/lib/taxRules";

export interface CashFlowRow {
  date: string;
  principal: number;
  interest: number;
  taxableIncome: number;
  taxBase: number;
  incomeTax: number;
  specialTax: number | null;
  netAmount: number;
}

export interface CashFlowScheduleInputs {
  maturityDate: string;
  couponRate: string;
  couponFrequency: CouponFrequency;
  purchaseYield: string;
  calcBasis: CalcBasis;
  trustContractDate: string;
  recentCouponDate: string;
  tradeCurrency: Currency;
  custodyCurrency: Currency;
  purchaseFxRate: string;
  maturityFxRate: string;
  trustInvestmentAmount: string;
  frontFeeRate: string;
  backFeeRate: string;
  investorType: InvestorType;
  taxStatus: TaxStatus;
  /** 결제일수(T+n 영업일). 생략/""이면 시장 관행 기본값. */
  settlementDays?: string;

  // 콜/조기상환 시나리오. 모두 생략 가능하며, hasCall이 false이거나 시나리오
  // 입력이 불완전하면 만기보유(hold)로 계산된다.
  hasCall?: boolean;
  callScenario?: CallScenario;
  parCallDate?: string;
  makeWholeRedemptionDate?: string;
  makeWholeRefYield?: string;
  makeWholeSpreadBps?: string;
}

function daysBetween(a: Date, b: Date): number {
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/** fix.xlsx의 이자계산일별 현금흐름(원금/이자/과세소득/과세표준/소득세/농특세/세후수령액) 계산 */
export function generateFixCashFlow(
  input: CashFlowScheduleInputs
): CashFlowRow[] | null {
  const pricing = computeBondPricing(input);
  if (!pricing) return null;

  const maturity = new Date(input.maturityDate);
  const contractDate = new Date(input.trustContractDate);
  if (Number.isNaN(maturity.getTime()) || Number.isNaN(contractDate.getTime()))
    return null;

  const rate = Number(input.couponRate) / 100;
  const backFeeRate = Number(input.backFeeRate);
  if (Number.isNaN(backFeeRate)) return null;

  const needsFx = input.tradeCurrency !== input.custodyCurrency;
  const maturityFxRate = needsFx ? Number(input.maturityFxRate) : 1;
  if (needsFx && (!maturityFxRate || Number.isNaN(maturityFxRate) || maturityFxRate <= 0)) {
    return null;
  }
  const months = FREQUENCY_MONTHS[input.couponFrequency];
  const freqPerYear = 12 / months;
  const trustInvestmentAmount = Number(input.trustInvestmentAmount);
  const frontFeeAmount = Math.trunc(
    trustInvestmentAmount * (Number(input.frontFeeRate) / 100)
  );

  // 콜/조기상환 시나리오. hold이면 redemption === maturity, 배수 1로 현행과 동일.
  // trustContractDate(→결제일)를 넘겨 상환일이 결제일 이전인 입력(과거 콜일 등)은
  // hold로 폴백하게 한다(감사 #3 — 하한 미검증 시 음수 이자/투자일수 발생).
  const eff = getEffectiveRedemption({
    hasCall: input.hasCall ?? false,
    callScenario: input.callScenario ?? "hold",
    maturityDate: input.maturityDate,
    parCallDate: input.parCallDate ?? "",
    makeWholeRedemptionDate: input.makeWholeRedemptionDate ?? "",
    makeWholeRefYield: input.makeWholeRefYield ?? "",
    makeWholeSpreadBps: input.makeWholeSpreadBps ?? "",
    couponRate: input.couponRate,
    couponFrequency: input.couponFrequency,
    calcBasis: input.calcBasis,
    tradeCurrency: input.tradeCurrency,
    trustContractDate: input.trustContractDate,
    settlementDays: input.settlementDays,
  });
  const redemption = new Date(eff.redemptionDate);
  if (Number.isNaN(redemption.getTime())) return null;

  // 이표일은 만기일 기준 anchored(만기에서 months×k개월씩 거슬러 올라간 날짜)로
  // 만든다 — recentCouponDate에서 연쇄로 더해나가면 월말 만기(예: 8/31)에서
  // 2월을 지나며 드리프트한다(감사 #5, getCouponPeriod/generateCouponSchedule과
  // 동일 원칙 — 커밋 2187d27 참고). recentCouponDate 이후 ~ 상환일까지만 남긴다.
  const recentCoupon = new Date(pricing.recentCouponDate);
  const fullGrid: Date[] = [];
  for (let k = 0; ; k++) {
    const d = addMonths(maturity, -months * k);
    if (d <= recentCoupon) break;
    fullGrid.unshift(d);
  }

  // 상환일이 이표 그리드에 없으면(예: "만기 1개월 전" par call) 마지막 행은
  // 상환일에 스텁(부분기간) 쿠폰 + 원금이 되고, 그 다음 예정 이표일
  // (nextGridCoupon)을 스텁 비율 계산의 분모 구간 끝으로 쓴다.
  const dates: Date[] = [];
  let stubRedemption = false;
  let nextGridCoupon = redemption;
  for (const d of fullGrid) {
    const cmp = toTime(d) - toTime(redemption);
    if (cmp < 0) {
      dates.push(d);
    } else if (cmp === 0) {
      dates.push(d);
      nextGridCoupon = d;
      break;
    } else {
      nextGridCoupon = d;
      stubRedemption = true;
      dates.push(new Date(redemption));
      break;
    }
  }
  if (dates.length === 0) {
    // fullGrid 전체가 상환일 이전(비정상 입력) — 상환일 자체를 스텁 1행으로.
    stubRedemption = true;
    dates.push(new Date(redemption));
  }

  // 스텁 최종행의 쿠폰 비율 = (직전 이표일~상환일) / (직전 이표일~다음 예정 이표일).
  const basisIdx = BASIS_INDEX[input.calcBasis];
  const prevGridCoupon = dates.length >= 2 ? dates[dates.length - 2] : recentCoupon;
  const fullPeriodFrac = yearFrac(prevGridCoupon, nextGridCoupon, basisIdx);
  const stubFraction =
    stubRedemption && fullPeriodFrac > 0
      ? yearFrac(prevGridCoupon, redemption, basisIdx) / fullPeriodFrac
      : 1;

  const couponAmount =
    roundDown((rate * pricing.faceValue) / freqPerYear, 2) * maturityFxRate;

  // 화면에 보이는 현금흐름표 각 열(원금/이자/과세소득/과세표준/소득세/농특세/
  // 세후수령액)은 수탁통화가 KRW면 정수로, 그 외는 소수점 2자리까지 절사해
  // 표시한다. 절사 전 값을 그대로 내부 계산에 쓰면 "이자-소득세-농특세=
  // 세후수령액" 같은 검산이 화면상 어긋나 보이므로, 표시값과 동일하게 절사한
  // 값을 각 행에 저장하고 그 절사값으로 다음 계산을 이어간다.
  const isKrw = input.custodyCurrency === "KRW";
  const truncByCurrency = (n: number) => (isKrw ? Math.trunc(n) : roundDown(n, 2));

  const rows: CashFlowRow[] = [];
  let periodStart = contractDate;
  let carryFrontFee = frontFeeAmount;
  let carryBackFeeResidual = 0;

  dates.forEach((date, index) => {
    // 마지막 행 = 원금상환일(만기 또는 콜). 콜이면 원금에 상환배수(make-whole
    // 프리미엄)를 적용하고, 이표 그리드에 없는 상환일이면 쿠폰은 스텁(부분기간).
    const isRedemption = index === dates.length - 1;
    const periodCoupon =
      isRedemption && stubRedemption ? couponAmount * stubFraction : couponAmount;
    const principal = truncByCurrency(
      isRedemption
        ? pricing.faceValue * eff.redemptionPriceFactor * maturityFxRate
        : 0
    );
    const interest = truncByCurrency(periodCoupon);

    let taxableIncome: number;
    if (index === 0) {
      // 경과이자 = 쿠폰의 경과연수 프로레이트 — couponAmount와 같은 기준이라야
      // "이자-경과이자"가 일치한다.
      const preOwnedInterest = couponAmount * pricing.accrualFraction * freqPerYear;
      taxableIncome = truncByCurrency(periodCoupon - preOwnedInterest);
    } else {
      taxableIncome = interest;
    }

    const availableFrontFee = carryFrontFee;
    const backFeeThisPeriod =
      (trustInvestmentAmount * (backFeeRate / 100) / 365) *
      daysBetween(periodStart, date);
    const availableBackFee = carryBackFeeResidual + backFeeThisPeriod;
    const totalDeduction = availableFrontFee + availableBackFee;

    // 완전 비과세(소득세·농특세 모두 없음)는 과세표준이 없다. 일반과세·
    // 비과세(농특세)는 쿠폰이 과세(각각 소득세/농특세) 대상이라 공제를 뺀 값.
    const isFullyExempt = input.taxStatus === "비과세";
    const taxBase = isFullyExempt
      ? 0
      : truncByCurrency(
          taxableIncome > totalDeduction ? taxableIncome - totalDeduction : 0
        );
    // 소득세 14% 절사 → 그 값의 10%를 주민세로 다시 절사(fix.xlsx 석유공사_USD
    // G/H열). 15.4%를 한 번에 곱해 절사하면 회차마다 1센트/10원씩 커진다(F10).
    // 화면 열 구성은 그대로 — "소득세" 열에 소득세+주민세 합산을 표시한다.
    // KRW는 원천징수 관행대로 10원 미만 절사, 그 외 통화는 소수 2자리 절사.
    const truncTax = (n: number) => (isKrw ? roundDown(n, -1) : roundDown(n, 2));
    const incomeTax = computeWithholdingTax(taxBase, input.taxStatus, truncTax).total;
    // 농특세(한국전력 7.95% 2096 전용)도 국세이므로 소득세와 같은 세액 절사
    // (KRW 10원 미만·그 외 소수 2자리)를 쓴다. fix.xlsx 한국전력 시트 H열은
    // F×1.4%를 절사 없이 두는데, 이는 정본 쪽 미절사(서식으로 가려짐)로 보고
    // 절사를 따른다(사용자 결정 2026-09-15). 차이는 회차당 10원 미만.
    const specialTaxRate = input.investorType === "개인" ? 0.014 : 0.028;
    const specialTax =
      input.taxStatus === "비과세(농특세)" ? truncTax(taxBase * specialTaxRate) : null;
    const netAmount = truncByCurrency(
      interest - backFeeThisPeriod - incomeTax - (specialTax ?? 0)
    );

    rows.push({
      date: date.toISOString().slice(0, 10),
      principal,
      interest,
      taxableIncome,
      taxBase,
      incomeTax,
      specialTax,
      netAmount,
    });

    // 공제는 "실제 과세되는 소득"만큼만 소진된다. 완전 비과세면 소진 없음
    // (선취보수가 첫 회차에 통째로 소각되던 문제). 일반과세·비과세(농특세)는
    // 쿠폰이 과세대상이라 공제가 그만큼 소진된다.
    const taxedThisPeriod = isFullyExempt ? 0 : taxableIncome;
    const deductionUsed = Math.min(totalDeduction, taxedThisPeriod);
    const frontUsed = Math.min(availableFrontFee, deductionUsed);
    carryFrontFee = availableFrontFee - frontUsed;
    carryBackFeeResidual = availableBackFee - (deductionUsed - frontUsed);
    periodStart = date;
  });

  return rows;
}

function toTime(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
