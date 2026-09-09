export type CalcBasis =
  | "미국 30/360"
  | "ACT/ACT"
  | "ACT/360"
  | "ACT/365"
  | "유럽 30/360"
  | "Business/252";

export type InvestorType = "개인" | "일반법인" | "금융법인";

export type CouponFrequency = "3개월" | "6개월" | "12개월";

export type Currency = "USD" | "EUR" | "CNY" | "JPY" | "KRW" | "BRL";

export type TaxStatus = "일반과세" | "비과세(농특세)" | "비과세";

export interface BondLayoutInput {
  calcBasis: CalcBasis;
  investorType: InvestorType;

  name: string;
  issueDate: string;
  maturityDate: string;
  couponRate: string;
  couponFrequency: CouponFrequency;
  recentCouponDate: string;
  taxStatus: TaxStatus;
  creditRating: string;
  tradeCurrency: Currency;
  custodyCurrency: Currency;
  purchaseFxRate: string;
  maturityFxRate: string;

  trustContractDate: string;
  /** 신탁만기일 수기 수정값(YYYY-MM-DD). 빈 문자열이면 자동계산(만기일+11일). */
  trustMaturityDate: string;
  purchaseYield: string;

  trustInvestmentAmount: string;
  frontFeeRate: string;
  backFeeRate: string;
  incomeTaxRate: string;
}
