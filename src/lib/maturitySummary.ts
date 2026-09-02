import { CashFlowRow } from "@/lib/cashFlowSchedule";
import { roundDown } from "@/lib/bondPricing";
import { getInvestmentDays } from "@/lib/couponSchedule";

const DEFAULT_COMPREHENSIVE_TAX_RATE = 0.154;

export interface MaturitySummaryInputs {
  trustContractDate: string;
  maturityDate: string;
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
    input.maturityDate
  );
  if (!investmentDays || rows.length === 0) return null;

  const totalInterest = rows.reduce((sum, row) => sum + row.interest, 0);
  const totalPrincipal = rows.reduce((sum, row) => sum + row.principal, 0);
  const totalNetAmount = rows.reduce((sum, row) => sum + row.netAmount, 0);
  if (!(totalPrincipal > 0)) return null;

  const totalInterestPaid = roundDown(totalInterest, 2);
  const preTaxMaturityAmount = roundDown(totalPrincipal + totalInterest, 2);
  const postTaxMaturityAmount = roundDown(totalPrincipal + totalNetAmount, 2);

  const preTaxYield =
    ((preTaxMaturityAmount - totalPrincipal) / totalPrincipal) *
    (365 / investmentDays);
  const postTaxYield =
    ((postTaxMaturityAmount - totalPrincipal) / totalPrincipal) *
    (365 / investmentDays);

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
