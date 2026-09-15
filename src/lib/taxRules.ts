import { TaxStatus } from "@/types/bondLayout";

// 현행 소득세 체계(fix.xlsx 석유공사_USD G/H열): 소득세 14% + 주민세(소득세의 10%).
// 합산 명목세율 15.4%지만, 정본은 소득세를 먼저 절사한 뒤 그 값의 10%를 다시
// 절사한다 — 15.4%를 한 번에 곱해 절사하면 회차마다 1센트/10원씩 정본보다
// 크게 나온다(Fable 감사 F10). 한국전력 7.95% 2096 채권만 구세법(소득세 0% +
// 농특세)으로 "비과세(농특세)"로 분류돼 이 함수는 0을 돌려준다.
export const INCOME_TAX_RATE = 0.14;
/** 주민세(지방소득세) = 소득세의 10% */
export const LOCAL_TAX_RATE_ON_INCOME_TAX = 0.1;

/**
 * 합산 명목세율(15.4% 또는 0). 은행환산수익률 기본값 등 "비율" 용도로만 쓰고,
 * 실제 세액 계산은 computeWithholdingTax(두 단계 절사)를 쓴다.
 */
export function getEffectiveIncomeTaxRate(taxStatus: TaxStatus): number {
  return taxStatus === "일반과세"
    ? INCOME_TAX_RATE * (1 + LOCAL_TAX_RATE_ON_INCOME_TAX)
    : 0;
}

export interface WithholdingTax {
  /** 소득세 = 절사(과세표준 × 14%) */
  incomeTax: number;
  /** 주민세 = 절사(소득세 × 10%) — 절사된 소득세 기준 */
  localTax: number;
  /** 소득세 + 주민세 (화면의 "소득세" 열에 합산 표시) */
  total: number;
}

/**
 * 원천징수 세액을 정본과 같은 순서로 계산한다: 소득세를 먼저 절사하고, 그
 * 절사값의 10%를 주민세로 다시 절사한다. `truncate`는 통화별 절사 규칙
 * (USD 등 소수 2자리, KRW 10원 미만 절사).
 */
export function computeWithholdingTax(
  taxBase: number,
  taxStatus: TaxStatus,
  truncate: (n: number) => number
): WithholdingTax {
  if (taxStatus !== "일반과세" || !(taxBase > 0)) {
    return { incomeTax: 0, localTax: 0, total: 0 };
  }
  const incomeTax = truncate(taxBase * INCOME_TAX_RATE);
  const localTax = truncate(incomeTax * LOCAL_TAX_RATE_ON_INCOME_TAX);
  return { incomeTax, localTax, total: incomeTax + localTax };
}
