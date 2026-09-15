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

/**
 * 콜/조기상환 시나리오.
 * - hold: 만기보유 (기본, 현행 동작)
 * - parCall: par call일에 액면(100%) 조기상환 (발행사 콜)
 * - makeWhole: 지정일에 make-whole 상환가(잔여현금흐름을 국채금리+스프레드로
 *   할인한 값과 액면 중 큰 값)로 조기상환 (발행사 콜)
 * (풋옵션은 일반 채권이 아니라는 판단으로 제외 — 2026-09-15)
 */
export type CallScenario = "hold" | "parCall" | "makeWhole";

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

  /** 콜조항 존재 여부. false면 콜 관련 입력을 모두 무시하고 만기보유로 계산. */
  hasCall: boolean;
  /** par call일(YYYY-MM-DD). 자동 파싱 또는 수기. "" = 미설정. */
  parCallDate: string;
  /** make-whole 스프레드(bp, 예 "15"). "" = 미확인. */
  makeWholeSpreadBps: string;
  /** 선택 시나리오. hasCall=false면 항상 hold로 취급. */
  callScenario: CallScenario;
  /** makeWhole 시나리오의 상환일(YYYY-MM-DD). */
  makeWholeRedemptionDate: string;
  /** makeWhole 상환가 계산용 기준 국채금리(%). 곡선에서 자동채움 후 수정 가능. */
  makeWholeRefYield: string;

  /**
   * SEC 조회용 ISIN. 미국채권검색으로 종목을 반영한 경우만 채워진다 —
   * 콜조항 체크박스 재조회(검색 없이 체크만 켜는 경우)의 조회 키로 쓰인다.
   */
  isin: string;
}
