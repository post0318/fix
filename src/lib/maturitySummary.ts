import { CashFlowRow } from "@/lib/cashFlowSchedule";
import { roundDown } from "@/lib/bondPricing";
import { getInvestmentDays } from "@/lib/couponSchedule";

const DEFAULT_COMPREHENSIVE_TAX_RATE = 0.154;

export interface MaturitySummaryInputs {
  trustContractDate: string;
  maturityDate: string;
  /**
   * 콜 시나리오의 실효 원금상환일. 있으면 투자일수(수익률 연환산 분모)가
   * 만기일 대신 이 값 기준으로 산출된다(현금흐름표도 이 날짜에 끝나야 일관).
   */
  redemptionDate?: string;
  /** 신탁만기일 수기 수정값. 있으면 투자일수가 이 값 기준으로 산출된다. */
  trustMaturityDate?: string;
  /**
   * 콜 시나리오의 원금상환 배수(1=액면, >1=make-whole 프리미엄). 수익률의
   * 분모(액면기준 원금)를 원금 합계에서 프리미엄을 분리해 구하는 데 쓰인다.
   * 없거나 1이면 원금 합계를 그대로 분모로 쓴다(기존 동작과 동일).
   */
  redemptionPriceFactor?: number;
  comprehensiveTaxRate: string;
}

export interface MaturitySummary {
  /** 지급이자총액 (세전, 현금흐름표 이자 합계) */
  totalInterestPaid: number;
  /** 만기시 세전금액 = 원금 합계 + 지급이자총액 */
  preTaxMaturityAmount: number;
  /** 만기시 세후금액 = 원금 합계 + 세후수령액 합계(수수료·세금 차감 후) */
  postTaxMaturityAmount: number;
  preTaxYield: number;
  postTaxYield: number;
  bankEquivalentYield: number;
}

/**
 * 만기시 세전/세후금액, 세전/세후수익률, 은행환산수익률.
 *
 * 브라질 현금흐름과 달리 원금은 현금흐름표 원금 합계(= 권면액 × 만기환율)를
 * 그대로 쓴다. 세전금액 = 원금 + 이자총액, 세후금액 = 원금 + 세후수령액총액.
 * 두 수익률의 분모도 동일하게 원금 합계다.
 */
export function computeMaturitySummary(
  rows: CashFlowRow[],
  input: MaturitySummaryInputs
): MaturitySummary | null {
  const investmentDays = getInvestmentDays(
    input.trustContractDate,
    input.redemptionDate || input.maturityDate,
    input.trustMaturityDate
  );
  if (!investmentDays || rows.length === 0) return null;

  const totalInterest = rows.reduce((sum, row) => sum + row.interest, 0);
  const totalPrincipal = rows.reduce((sum, row) => sum + row.principal, 0);
  const totalNetAmount = rows.reduce((sum, row) => sum + row.netAmount, 0);
  if (!(totalPrincipal > 0)) return null;

  const totalInterestPaid = roundDown(totalInterest, 2);
  const preTaxMaturityAmount = roundDown(totalPrincipal + totalInterest, 2);
  const postTaxMaturityAmount = roundDown(totalPrincipal + totalNetAmount, 2);

  // 수익률의 분모는 액면기준 원금(프리미엄 제외)이어야 한다. make-whole
  // 프리미엄은 totalPrincipal에 이미 포함돼 있는데, 분모를 totalPrincipal
  // 그대로 쓰면 분자(만기시금액-원금)에서 프리미엄이 상쇄돼 "프리미엄이
  // 클수록 표시 수익률이 낮아지는" 부호 오류가 난다(감사 #1). 배수로
  // 나눠 액면기준 원금을 복원하고, 프리미엄은 분자(수익)에 남긴다.
  const factor =
    input.redemptionPriceFactor && input.redemptionPriceFactor > 0
      ? input.redemptionPriceFactor
      : 1;
  const yieldBase = factor !== 1 ? totalPrincipal / factor : totalPrincipal;
  if (!(yieldBase > 0)) return null;

  const preTaxYield =
    ((preTaxMaturityAmount - yieldBase) / yieldBase) * (365 / investmentDays);
  const postTaxYield =
    ((postTaxMaturityAmount - yieldBase) / yieldBase) * (365 / investmentDays);

  const parsedComprehensiveTaxRate = Number(input.comprehensiveTaxRate);
  const comprehensiveTaxRate =
    input.comprehensiveTaxRate && !Number.isNaN(parsedComprehensiveTaxRate)
      ? parsedComprehensiveTaxRate / 100
      : DEFAULT_COMPREHENSIVE_TAX_RATE;
  const bankEquivalentYield = postTaxYield / (1 - comprehensiveTaxRate);

  return {
    totalInterestPaid,
    preTaxMaturityAmount,
    postTaxMaturityAmount,
    preTaxYield,
    postTaxYield,
    bankEquivalentYield,
  };
}
