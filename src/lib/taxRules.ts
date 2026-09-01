import { TaxStatus } from "@/types/bondLayout";

// 현행법 일반과세: 소득세 14% + 지방소득세(소득세의 10%) 1.4% = 15.4%.
// (석유공사 등 현행 채권. 한국전력은 구세법으로 소득세 비과세 + 농특세 별도 →
//  "비과세(농특세)" 상태로 분류돼 이 함수는 0을 반환한다.)
const GENERAL_TAX_RATE = 0.154;

/**
 * 과세여부가 일반과세면 개인/법인 모두 15.4%, 비과세·비과세(농특세)면 개인/법인 모두 0%.
 * (비과세(농특세)는 소득세는 0%이나 농특세는 별도로 부과된다.)
 */
export function getEffectiveIncomeTaxRate(taxStatus: TaxStatus): number {
  return taxStatus === "일반과세" ? GENERAL_TAX_RATE : 0;
}
