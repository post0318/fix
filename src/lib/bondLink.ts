import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from "lz-string";
import {
  BondLayoutInput,
  CalcBasis,
  CallScenario,
  CouponFrequency,
  Currency,
  InvestorType,
  TaxStatus,
} from "@/types/bondLayout";

const CALL_SCENARIO_TO_CODE: Record<CallScenario, number> = {
  hold: 0,
  parCall: 1,
  makeWhole: 2,
  put: 3,
};
const CALL_SCENARIO_BY_CODE: Record<number, CallScenario> = {
  0: "hold",
  1: "parCall",
  2: "makeWhole",
  3: "put",
};

const COUPON_FREQUENCY_TO_CODE: Record<CouponFrequency, number> = {
  "3개월": 1,
  "6개월": 2,
  "12개월": 3,
};
const COUPON_FREQUENCY_BY_CODE: Record<number, CouponFrequency> = {
  1: "3개월",
  2: "6개월",
  3: "12개월",
};

const TAX_STATUS_TO_CODE: Record<TaxStatus, number> = {
  일반과세: 1,
  "비과세(농특세)": 2,
  비과세: 3,
};
const TAX_STATUS_BY_CODE: Record<number, TaxStatus> = {
  1: "일반과세",
  2: "비과세(농특세)",
  3: "비과세",
};

const CALC_BASIS_TO_CODE: Record<CalcBasis, number> = {
  "미국 30/360": 1,
  "ACT/ACT": 2,
  "ACT/360": 3,
  "ACT/365": 4,
  "유럽 30/360": 5,
  "Business/252": 6,
};
const CALC_BASIS_BY_CODE: Record<number, CalcBasis> = {
  1: "미국 30/360",
  2: "ACT/ACT",
  3: "ACT/360",
  4: "ACT/365",
  5: "유럽 30/360",
  6: "Business/252",
};

const CURRENCY_TO_CODE: Record<Currency, number> = {
  USD: 1,
  EUR: 2,
  CNY: 3,
  JPY: 4,
  KRW: 0,
  BRL: 5,
};
const CURRENCY_BY_CODE: Record<number, Currency> = {
  1: "USD",
  2: "EUR",
  3: "CNY",
  4: "JPY",
  0: "KRW",
  5: "BRL",
};

const INVESTOR_TYPE_TO_CODE: Record<InvestorType, number> = {
  개인: 1,
  일반법인: 2,
  금융법인: 3,
};
const INVESTOR_TYPE_BY_CODE: Record<number, InvestorType> = {
  1: "개인",
  2: "일반법인",
  3: "금융법인",
};

// 최소 필드 수(하위호환). 신탁만기일이 21번째로 추가됐지만, 그 이전에
// 생성된 20개짜리 링크도 계속 열 수 있도록 최소값은 20으로 유지한다.
const FIELD_COUNT = 20;

const MS_PER_DAY = 86400000;

/**
 * "1996-04-01" -> 1970-01-01 기준 경과일수의 36진수 문자열(예: "7eb")로
 * 압축해 링크 길이를 줄인다. "19960401" 같은 8자리 숫자 압축(이전 방식)
 * 보다 훨씬 짧다.
 */
function stripDateDashes(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const days = Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
  return days.toString(36);
}

/**
 * 36진수 경과일수 -> "1996-04-01". 예전에 생성된 링크(8자리 숫자 압축)도
 * 계속 열 수 있도록 "YYYYMMDD" 형태는 그대로 이전 방식으로 복원한다.
 */
function restoreDateDashes(compact: string): string {
  if (/^\d{8}$/.test(compact)) {
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  }
  if (/^-?[0-9a-z]+$/.test(compact)) {
    const days = parseInt(compact, 36);
    if (!Number.isNaN(days)) {
      const dt = new Date(days * MS_PER_DAY);
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const d = String(dt.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }
  return compact;
}

/**
 * 화면 전체 입력값(24개 필드)을 "|" 구분 문자열로 압축한다. 링크를 열면
 * 원본과 동일한 값으로 시작하고, 이후 영업점이 매수내역/상품수익률 항목을
 * 직접 수정하면 그때부터 달라진다. 코드값(이자지급주기/과세여부/날짜계산
 * 기준/통화/소득자구분)을 써서 JSON 키 이름 없이 값만 나열하므로 링크
 * 길이가 짧아진다.
 */
function pack(value: BondLayoutInput): string {
  const fields = [
    value.name,
    stripDateDashes(value.issueDate),
    stripDateDashes(value.maturityDate),
    value.couponRate,
    String(COUPON_FREQUENCY_TO_CODE[value.couponFrequency] ?? ""),
    stripDateDashes(value.recentCouponDate),
    String(TAX_STATUS_TO_CODE[value.taxStatus] ?? ""),
    String(CALC_BASIS_TO_CODE[value.calcBasis] ?? ""),
    value.creditRating,
    String(CURRENCY_TO_CODE[value.tradeCurrency] ?? ""),
    String(CURRENCY_TO_CODE[value.custodyCurrency] ?? ""),
    String(INVESTOR_TYPE_TO_CODE[value.investorType] ?? ""),
    value.purchaseFxRate,
    value.maturityFxRate,
    stripDateDashes(value.trustContractDate),
    value.purchaseYield,
    value.trustInvestmentAmount,
    value.frontFeeRate,
    value.backFeeRate,
    value.incomeTaxRate,
    stripDateDashes(value.trustMaturityDate),
    value.hasCall ? "1" : "",
    stripDateDashes(value.parCallDate),
    value.makeWholeSpreadBps,
    String(CALL_SCENARIO_TO_CODE[value.callScenario] ?? 0),
    stripDateDashes(value.makeWholeRedemptionDate),
    value.makeWholeRefYield,
    value.isin,
    value.hasPut ? "1" : "",
    stripDateDashes(value.putDate),
  ];
  return fields.map((f) => (f ?? "").replace(/\|/g, " ")).join("|");
}

function unpack(text: string): Partial<BondLayoutInput> | null {
  const parts = text.split("|");
  if (parts.length < FIELD_COUNT) return null;

  const [
    name,
    issueDate,
    maturityDate,
    couponRate,
    couponFrequencyCode,
    recentCouponDate,
    taxStatusCode,
    calcBasisCode,
    creditRating,
    tradeCurrencyCode,
    custodyCurrencyCode,
    investorTypeCode,
    purchaseFxRate,
    maturityFxRate,
    trustContractDate,
    purchaseYield,
    trustInvestmentAmount,
    frontFeeRate,
    backFeeRate,
    incomeTaxRate,
    trustMaturityDate,
    hasCall,
    parCallDate,
    makeWholeSpreadBps,
    callScenarioCode,
    makeWholeRedemptionDate,
    makeWholeRefYield,
    isin,
    hasPut,
    putDate,
  ] = parts;

  const result: Partial<BondLayoutInput> = {};
  if (name) result.name = name;
  if (issueDate) result.issueDate = restoreDateDashes(issueDate);
  if (maturityDate) result.maturityDate = restoreDateDashes(maturityDate);
  if (couponRate) result.couponRate = couponRate;
  if (recentCouponDate) result.recentCouponDate = restoreDateDashes(recentCouponDate);
  if (creditRating) result.creditRating = creditRating;
  if (purchaseFxRate) result.purchaseFxRate = purchaseFxRate;
  if (maturityFxRate) result.maturityFxRate = maturityFxRate;
  if (trustContractDate) result.trustContractDate = restoreDateDashes(trustContractDate);
  if (trustMaturityDate) result.trustMaturityDate = restoreDateDashes(trustMaturityDate);
  if (hasCall === "1") result.hasCall = true;
  if (parCallDate) result.parCallDate = restoreDateDashes(parCallDate);
  if (makeWholeSpreadBps) result.makeWholeSpreadBps = makeWholeSpreadBps;
  if (makeWholeRedemptionDate)
    result.makeWholeRedemptionDate = restoreDateDashes(makeWholeRedemptionDate);
  if (makeWholeRefYield) result.makeWholeRefYield = makeWholeRefYield;
  if (isin) result.isin = isin;
  if (hasPut === "1") result.hasPut = true;
  if (putDate) result.putDate = restoreDateDashes(putDate);
  if (callScenarioCode) {
    const scenario = CALL_SCENARIO_BY_CODE[Number(callScenarioCode)];
    if (scenario) result.callScenario = scenario;
  }
  if (purchaseYield) result.purchaseYield = purchaseYield;
  if (trustInvestmentAmount) result.trustInvestmentAmount = trustInvestmentAmount;
  if (frontFeeRate) result.frontFeeRate = frontFeeRate;
  if (backFeeRate) result.backFeeRate = backFeeRate;
  if (incomeTaxRate) result.incomeTaxRate = incomeTaxRate;

  if (couponFrequencyCode !== "") {
    const couponFrequency = COUPON_FREQUENCY_BY_CODE[Number(couponFrequencyCode)];
    if (couponFrequency) result.couponFrequency = couponFrequency;
  }
  if (taxStatusCode !== "") {
    const taxStatus = TAX_STATUS_BY_CODE[Number(taxStatusCode)];
    if (taxStatus) result.taxStatus = taxStatus;
  }
  if (calcBasisCode !== "") {
    const calcBasis = CALC_BASIS_BY_CODE[Number(calcBasisCode)];
    if (calcBasis) result.calcBasis = calcBasis;
  }
  if (tradeCurrencyCode !== "") {
    const tradeCurrency = CURRENCY_BY_CODE[Number(tradeCurrencyCode)];
    if (tradeCurrency) result.tradeCurrency = tradeCurrency;
  }
  if (custodyCurrencyCode !== "") {
    const custodyCurrency = CURRENCY_BY_CODE[Number(custodyCurrencyCode)];
    if (custodyCurrency) result.custodyCurrency = custodyCurrency;
  }
  if (investorTypeCode !== "") {
    const investorType = INVESTOR_TYPE_BY_CODE[Number(investorTypeCode)];
    if (investorType) result.investorType = investorType;
  }

  return result;
}

/** 화면 전체 입력값을 담아 현재 페이지 URL에 붙일 공유 링크를 만든다 */
export function encodeBondLink(value: BondLayoutInput): string {
  const encoded = compressToEncodedURIComponent(pack(value));

  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("bond", encoded);
  return url.toString();
}

/** 링크의 bond 쿼리 파라미터를 화면 입력값으로 되돌린다 */
export function decodeBondLink(search: string): Partial<BondLayoutInput> | null {
  const encoded = new URLSearchParams(search).get("bond");
  if (!encoded) return null;

  try {
    const text = decompressFromEncodedURIComponent(encoded);
    if (!text) return null;
    return unpack(text);
  } catch {
    return null;
  }
}
