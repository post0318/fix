import { CashFlowRow } from "@/lib/cashFlowSchedule";
import { roundDown } from "@/lib/bondPricing";
import {
  getInvestmentDays,
  getTrustMaturityLeadDays,
} from "@/lib/couponSchedule";

const DEFAULT_COMPREHENSIVE_TAX_RATE = 0.154;

export interface MaturitySummaryInputs {
  trustContractDate: string;
  maturityDate: string;
  /**
   * 콜/풋 시나리오의 실효 원금상환일. 있으면 투자일수(수익률 연환산 분모)가
   * 만기일 대신 이 값 기준으로 산출된다(현금흐름표도 이 날짜에 끝나야 일관).
   */
  redemptionDate?: string;
  /** 신탁만기일 수기 수정값. (override − 자산만기) 차이일이 리드타임이 된다. */
  trustMaturityDate?: string;
  /** 신탁투자금액 — 수익률의 분모이자 수익금(만기시금액 − 투자금)의 기준. */
  trustInvestmentAmount: string;
  /** 후취보수율(%) — 세전금액은 투자일수 전체분, 세후금액은 마지막(리드타임) 분을 차감. */
  backFeeRate: string;
  /** 매수 시점 현금잔액(투자금 − 선취보수 − 결제금액). 만기시금액에 그대로 더한다. */
  cashBalance: number;
  comprehensiveTaxRate: string;
}

export interface MaturitySummary {
  /** 지급이자총액 (세전, 현금흐름표 이자 합계) */
  totalInterestPaid: number;
  /** 만기시 세전금액 = 원금 합계 + 이자 합계 + 현금잔액 − 후취보수 총액 (fix.xlsx G10) */
  preTaxMaturityAmount: number;
  /** 만기시 세후금액 = 원금 합계 + 세후수령액 합계 + 현금잔액 − 마지막 후취보수 (G11) */
  postTaxMaturityAmount: number;
  preTaxYield: number;
  postTaxYield: number;
  bankEquivalentYield: number;
}

/**
 * 만기시 세전/세후금액, 세전/세후수익률, 은행환산수익률 — fix.xlsx G10~G15.
 *
 * 수익률 = (만기시금액 − 신탁투자금액) ÷ 신탁투자금액 × 365 ÷ 투자일수.
 * 분자·분모 모두 실제로 넣은 돈(신탁투자금액) 기준이라 매수단가 프리미엄/
 * 할인, 선취보수(→현금잔액), 후취보수가 전부 수익에 반영된다. 커밋 6d35770이
 * 이를 "원금 합계(액면) 대비 이자"로 바꿨던 것은 화면에서 마지막 후취보수
 * 행을 없애려던 의도가 계산까지 바꾼 것이었으므로(사용자 확인) 정본 정의로
 * 되돌린다 — 표시만 없애고 계산은 백그라운드에서 그대로 한다(Fable 감사 F1).
 *
 * - 세전금액의 후취보수는 투자일수 전체분(투자금 × 율 ÷ 365 × 투자일수).
 * - 세후금액은 현금흐름표 세후수령액에 회차별 후취보수가 이미 차감돼 있어,
 *   어느 행에도 없는 마지막 리드타임(기본 11일)분만 추가로 뺀다.
 * - 콜/풋 시나리오: 원금 합계(make-whole 프리미엄 포함)와 투자일수(상환일
 *   기준)가 행 데이터·리드타임에서 자연히 따라온다 — 별도 보정 없음.
 */
export function computeMaturitySummary(
  rows: CashFlowRow[],
  input: MaturitySummaryInputs
): MaturitySummary | null {
  const investmentDays = getInvestmentDays(
    input.trustContractDate,
    input.redemptionDate || input.maturityDate,
    input.trustMaturityDate,
    input.maturityDate
  );
  if (!investmentDays || investmentDays <= 0 || rows.length === 0) return null;

  const principal = Number(input.trustInvestmentAmount);
  const backFeeRate = Number(input.backFeeRate);
  if (
    !input.trustInvestmentAmount ||
    Number.isNaN(principal) ||
    principal <= 0 ||
    Number.isNaN(backFeeRate) ||
    Number.isNaN(input.cashBalance)
  ) {
    return null;
  }

  const totalInterest = rows.reduce((sum, row) => sum + row.interest, 0);
  const totalPrincipal = rows.reduce((sum, row) => sum + row.principal, 0);
  const totalNetAmount = rows.reduce((sum, row) => sum + row.netAmount, 0);
  if (!(totalPrincipal > 0)) return null;

  const dailyBackFee = (principal * (backFeeRate / 100)) / 365;
  const totalBackFeeEstimate = dailyBackFee * investmentDays;
  const leadDays = getTrustMaturityLeadDays(
    input.maturityDate,
    input.trustMaturityDate
  );
  const lastBackFee = roundDown(dailyBackFee * Math.max(leadDays, 0), 2);

  const totalInterestPaid = roundDown(totalInterest, 2);
  const preTaxMaturityAmount = roundDown(
    totalInterest + totalPrincipal + input.cashBalance - totalBackFeeEstimate,
    2
  );
  const postTaxMaturityAmount = roundDown(
    totalNetAmount + totalPrincipal + input.cashBalance - lastBackFee,
    2
  );

  const preTaxYield =
    ((preTaxMaturityAmount - principal) / principal) * (365 / investmentDays);
  const postTaxYield =
    ((postTaxMaturityAmount - principal) / principal) * (365 / investmentDays);

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
