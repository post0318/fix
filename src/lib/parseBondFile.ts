import * as XLSX from "xlsx";
import {
  BondLayoutInput,
  CalcBasis,
  CouponFrequency,
  Currency,
  TaxStatus,
} from "@/types/bondLayout";

type UploadableField =
  | "name"
  | "issueDate"
  | "maturityDate"
  | "couponRate"
  | "couponFrequency"
  | "recentCouponDate"
  | "taxStatus"
  | "calcBasis"
  | "creditRating"
  | "frontFeeRate"
  | "backFeeRate"
  | "tradeCurrency"
  | "custodyCurrency";

const LABEL_TO_FIELD: Record<string, UploadableField> = {
  종목명: "name",
  발행일: "issueDate",
  만기일: "maturityDate",
  표면이율: "couponRate",
  "표면이율(%)": "couponRate",
  "이자지급 주기": "couponFrequency",
  최근이표일: "recentCouponDate",
  과세여부: "taxStatus",
  "날짜계산 기준": "calcBasis",
  신용등급: "creditRating",
  해외신용등급: "creditRating",
  선취보수율: "frontFeeRate",
  "선취보수율(%)": "frontFeeRate",
  후취보수율: "backFeeRate",
  "후취보수율(%)": "backFeeRate",
  거래통화: "tradeCurrency",
  수탁통화: "custodyCurrency",
};

const CURRENCY_VALUES: Currency[] = ["USD", "EUR", "CNY", "JPY", "KRW", "BRL"];

const CALC_BASIS_VALUES: CalcBasis[] = [
  "미국 30/360",
  "ACT/ACT",
  "ACT/360",
  "ACT/365",
  "유럽 30/360",
];

const TAX_STATUS_VALUES: TaxStatus[] = ["일반과세", "비과세(농특세)", "비과세"];

const COUPON_FREQUENCY_VALUES: CouponFrequency[] = ["3개월", "6개월", "12개월"];

/**
 * 업로드 파일에서 숫자 구분자로 들어오는 필드의 코드 매핑.
 * 1. 이자지급 주기: 3개월=1, 6개월=2, 12개월=3
 * 2. 날짜계산 기준: 미국 30/360=1, ACT/ACT=2, ACT/360=3, ACT/365=4, 유럽 30/360=5
 * 3. 과세여부: 일반과세=1, 비과세(농특세)=2, 비과세=3
 * 4. 거래통화: USD=1, EUR=2, CNY=3, JPY=4, KRW=0
 */
const TAX_STATUS_BY_CODE: Record<number, TaxStatus> = {
  1: "일반과세",
  2: "비과세(농특세)",
  3: "비과세",
};

const CALC_BASIS_BY_CODE: Record<number, CalcBasis> = {
  1: "미국 30/360",
  2: "ACT/ACT",
  3: "ACT/360",
  4: "ACT/365",
  5: "유럽 30/360",
};

const COUPON_FREQUENCY_BY_CODE: Record<number, CouponFrequency> = {
  1: "3개월",
  2: "6개월",
  3: "12개월",
};

const TRADE_CURRENCY_BY_CODE: Record<number, Currency> = {
  1: "USD",
  2: "EUR",
  3: "CNY",
  4: "JPY",
  0: "KRW",
};

/**
 * 엑셀 날짜 값을 ISO(yyyy-mm-dd) 문자열로 변환한다.
 * 숫자(엑셀 시리얼 값)는 XLSX.SSF.parse_date_code로 직접 계산해, cellDates:true가
 * 만들어내는 JS Date 객체를 거치지 않는다 — 한국 등 일부 시간대에서는 1899-12-30
 * 기준일에 적용되는 역사적 시간대 오프셋(예: 구한국표준시 UTC+8:27:52) 때문에
 * new Date()로 변환한 날짜가 하루 전으로 밀리는 문제가 있다.
 */
function toIsoDate(value: unknown): string | null {
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    const y = parsed.y;
    const m = String(parsed.m).padStart(2, "0");
    const d = String(parsed.d).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    return null;
  }
  return null;
}

/**
 * 업로드된 엑셀에서 라벨 텍스트를 찾아 바로 오른쪽 셀 값을 대응 필드로 매핑한다.
 * top_lay.xlsx(라벨/값이 인접 컬럼에 배치된 구조)와 동일한 방식의 파일이면 시트 레이아웃과 무관하게 인식된다.
 */
export function parseBondFile(buffer: ArrayBuffer): Partial<BondLayoutInput> {
  const workbook = XLSX.read(buffer, { type: "array" });
  const result: Partial<BondLayoutInput> = {};
  const found = new Set<UploadableField>();
  // 표면이율 raw 값. 단위 정규화(퍼센트 vs 소수) 판별자로 쓴다.
  let couponRateRaw: number | null = null;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const ref = sheet["!ref"];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);

    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (!cell || typeof cell.v !== "string") continue;

        const field = LABEL_TO_FIELD[cell.v.trim()];
        if (!field || found.has(field)) continue;

        const valueCell = sheet[XLSX.utils.encode_cell({ r, c: c + 1 })];
        if (!valueCell || valueCell.v === undefined || valueCell.v === "")
          continue;

        if (field === "name" || field === "creditRating") {
          result[field] = String(valueCell.v);
          found.add(field);
        } else if (
          field === "issueDate" ||
          field === "maturityDate" ||
          field === "recentCouponDate"
        ) {
          const iso = toIsoDate(valueCell.v);
          if (iso) {
            result[field] = iso;
            found.add(field);
          }
        } else if (field === "couponRate") {
          const raw = Number(valueCell.v);
          if (!Number.isNaN(raw)) {
            couponRateRaw = raw;
            result.couponRate = String(raw); // 정규화는 루프 후 일괄
            found.add(field);
          }
        } else if (field === "frontFeeRate" || field === "backFeeRate") {
          const raw = Number(valueCell.v);
          if (!Number.isNaN(raw)) {
            result[field] = String(raw); // 정규화는 루프 후 일괄
            found.add(field);
          }
        } else if (field === "couponFrequency") {
          const text =
            typeof valueCell.v === "string" ? valueCell.v.trim() : "";
          if (COUPON_FREQUENCY_VALUES.includes(text as CouponFrequency)) {
            result.couponFrequency = text as CouponFrequency;
            found.add(field);
          } else {
            const couponFrequency = COUPON_FREQUENCY_BY_CODE[Number(valueCell.v)];
            if (couponFrequency) {
              result.couponFrequency = couponFrequency;
              found.add(field);
            }
          }
        } else if (field === "calcBasis") {
          const text =
            typeof valueCell.v === "string" ? valueCell.v.trim() : "";
          if (CALC_BASIS_VALUES.includes(text as CalcBasis)) {
            result.calcBasis = text as CalcBasis;
            found.add(field);
          } else {
            const calcBasis = CALC_BASIS_BY_CODE[Number(valueCell.v)];
            if (calcBasis) {
              result.calcBasis = calcBasis;
              found.add(field);
            }
          }
        } else if (field === "taxStatus") {
          const text =
            typeof valueCell.v === "string" ? valueCell.v.trim() : "";
          if (TAX_STATUS_VALUES.includes(text as TaxStatus)) {
            result.taxStatus = text as TaxStatus;
            found.add(field);
          } else {
            const taxStatus = TAX_STATUS_BY_CODE[Number(valueCell.v)];
            if (taxStatus) {
              result.taxStatus = taxStatus;
              found.add(field);
            }
          }
        } else if (field === "tradeCurrency" || field === "custodyCurrency") {
          const text = String(valueCell.v).trim().toUpperCase();
          if (CURRENCY_VALUES.includes(text as Currency)) {
            result[field] = text as Currency;
            found.add(field);
          } else if (field === "tradeCurrency") {
            const currency = TRADE_CURRENCY_BY_CODE[Number(valueCell.v)];
            if (currency) {
              result.tradeCurrency = currency;
              found.add(field);
            }
          }
        }
      }
    }
  }

  // 표면이율·보수율 단위 정규화. fix.xlsx·top_lay.xlsx·입력레이아웃.xlsx 등
  // 레포 동봉 레이아웃 파일은 이 값들을 소수(0.0795)로, up.xlsx·샘플.xlsx 등
  // 정상 업로드 포맷은 퍼센트(7.95)로 저장한다. 표면이율은 이 상품군에서 항상
  // 1% 이상이므로 raw가 1 미만이면 파일 전체가 소수 표기로 보고 세 값을 ×100
  // 한다. (보수율은 0.5%처럼 1 미만이 정상이라 단독 판별 불가 → 표면이율을
  // 파일 단위 판별자로 쓴다.)
  const fractional =
    couponRateRaw != null && couponRateRaw > 0 && couponRateRaw < 1;
  const scale = fractional ? 100 : 1;
  if (result.couponRate != null) {
    const n = Number(result.couponRate);
    result.couponRate = Number.isNaN(n)
      ? undefined
      : String(Math.round(n * scale * 100) / 100);
  }
  for (const f of ["frontFeeRate", "backFeeRate"] as const) {
    if (result[f] == null) continue;
    const n = Number(result[f]);
    result[f] = Number.isNaN(n)
      ? undefined
      : (Math.round(n * scale * 100) / 100).toFixed(2);
  }

  return result;
}
