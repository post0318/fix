import {
  CouponFrequency,
  Currency,
  InvestorType,
  CalcBasis,
  TaxStatus,
} from "@/types/bondLayout";
import { FREQUENCY_MONTHS, addMonths } from "@/lib/couponSchedule";
import {
  anbimaCouponFactor,
  computeBondPricing,
  roundDown,
} from "@/lib/bondPricing";
import { getEffectiveIncomeTaxRate } from "@/lib/taxRules";

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

  // 이자계산일 목록: 결제일 이후 첫 이표일부터 만기일까지 (만기일 그대로 마지막 원금상환일)
  const dates: Date[] = [];
  let cursor = new Date(pricing.recentCouponDate);
  cursor = addMonths(cursor, months);
  while (cursor <= maturity) {
    dates.push(cursor);
    if (toTime(cursor) === toTime(maturity)) break;
    cursor = addMonths(cursor, months);
  }
  if (dates.length === 0) return null;

  // 브라질 국채(Business/252)는 표면금리를 단순 나눗셈이 아니라 복리로 환산한
  // 반기 실효쿠폰을 지급한다(예: 연 10% -> 반기 4.880885%). 블룸버그 실제 값과
  // 대조해 확인함(computeBrazilDirtyPrice 참고).
  const couponAmount = roundDown(
    input.calcBasis === "Business/252"
      ? pricing.faceValue * anbimaCouponFactor(rate, freqPerYear)
      : (rate * pricing.faceValue) / freqPerYear,
    2
  ) * maturityFxRate;

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
    const isMaturity = toTime(date) === toTime(maturity);
    const principal = truncByCurrency(isMaturity ? pricing.faceValue * maturityFxRate : 0);
    const interest = truncByCurrency(couponAmount);

    let taxableIncome: number;
    if (index === 0) {
      // 경과이자(juros decorridos): 브라질은 ANBIMA 복리식(pricing.accruedInterest,
      // BRL 액면통화 기준)을 수탁통화로 환산해 쓴다. 그 외는 쿠폰의 경과연수
      // 프로레이트 — couponAmount와 같은 기준이라야 "이자-경과이자"가 일치한다.
      const preOwnedInterest =
        input.calcBasis === "Business/252"
          ? roundDown(pricing.accruedInterest, 2) * maturityFxRate
          : couponAmount * pricing.accrualFraction * freqPerYear;
      taxableIncome = truncByCurrency(couponAmount - preOwnedInterest);
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
    const incomeTaxRate = getEffectiveIncomeTaxRate(input.taxStatus);
    const incomeTax = isKrw
      ? roundDown(taxBase * incomeTaxRate, -1)
      : roundDown(taxBase * incomeTaxRate, 2);
    const specialTaxRate = input.investorType === "개인" ? 0.014 : 0.028;
    const specialTax =
      input.taxStatus === "비과세(농특세)"
        ? truncByCurrency(taxBase * specialTaxRate)
        : null;
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
