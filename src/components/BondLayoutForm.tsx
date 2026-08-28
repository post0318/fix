"use client";

import {
  ChangeEvent,
  Dispatch,
  FocusEvent,
  KeyboardEvent,
  ReactNode,
  SetStateAction,
  useMemo,
  useState,
} from "react";
import {
  BondLayoutInput,
  CalcBasis,
  CouponFrequency,
  Currency,
  InvestorType,
  TaxStatus,
} from "@/types/bondLayout";
import {
  getInvestmentDays,
  getRecentCouponDate,
  getSettlementDate,
  getTrustMaturityDate,
} from "@/lib/couponSchedule";
import { computeBondPricing } from "@/lib/bondPricing";
import { generateFixCashFlow } from "@/lib/cashFlowSchedule";
import { computeMaturitySummary } from "@/lib/maturitySummary";
import { parseBondFile } from "@/lib/parseBondFile";
import { encodeBondLink } from "@/lib/bondLink";
import { BondSearchBox } from "@/components/BondSearchBox";
import { UsBondSearchBox } from "@/components/UsBondSearchBox";
import { KoreaBondSearchBox } from "@/components/KoreaBondSearchBox";
import { BrazilBondSearchBox } from "@/components/BrazilBondSearchBox";

function formatAmount(n: number): string {
  return n.toLocaleString("ko-KR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * 수탁통화가 KRW면 소수점 이하를 절사(trunc)해 정수로, 그 외는 소수점
 * 2자리까지 절사(반올림 아님)해 표시한다. 계산값(bondPricing.ts의
 * settlementAmount 등)도 동일한 절사 규칙을 쓰므로, "매수가능금액-결제금액"을
 * 직접 계산해도 화면의 현금잔액과 일치한다.
 */
function formatSettlementAmount(n: number, isKrw: boolean): string {
  if (isKrw) return Math.trunc(n).toLocaleString("ko-KR");
  const truncated = Math.trunc(n * 100) / 100;
  return truncated.toLocaleString("ko-KR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * 종목검색 결과를 반영할 때 거래통화가 함께 바뀌면 수탁통화도 기본으로
 * 따라가도록 한다(거래통화 우선, 동일 통화가 기본값). 거래통화-수탁통화가
 * 같으면 환율은 1로 고정, 다르면 사용자가 직접 입력해야 하므로 비워둔다.
 * 거래통화 셀렉트를 수동으로 바꿀 때의 동작과 동일하다.
 */
function applyFieldsWithCurrencySync(
  value: BondLayoutInput,
  fields: Partial<BondLayoutInput>
): BondLayoutInput {
  const tradeCurrency = fields.tradeCurrency;
  if (!tradeCurrency) {
    return { ...value, ...fields };
  }
  // 검색 쪽에서 수탁통화를 명시했으면(예: 브라질채권검색은 거래통화 BRL,
  // 수탁통화 KRW가 기본값) 그 값을 그대로 쓰고, 명시하지 않았으면 기존처럼
  // 거래통화와 같은 통화로 자동 연동한다.
  const custodyCurrency = fields.custodyCurrency ?? tradeCurrency;
  // 수탁통화가 이전 선택(예: 브라질채권검색의 KRW)에서 바뀌면, 신탁투자금액도
  // 이전 종목의 값이 남지 않도록 통화별 기본값으로 되돌린다.
  const trustInvestmentAmount =
    custodyCurrency === value.custodyCurrency
      ? value.trustInvestmentAmount
      : custodyCurrency === "KRW"
        ? "100000000"
        : "1000000";
  if (tradeCurrency === custodyCurrency) {
    return {
      ...value,
      ...fields,
      custodyCurrency,
      purchaseFxRate: "1",
      maturityFxRate: "1",
      trustInvestmentAmount,
    };
  }
  return {
    ...value,
    ...fields,
    custodyCurrency,
    purchaseFxRate: "",
    maturityFxRate: "",
    trustInvestmentAmount,
  };
}

interface BondLayoutFormProps {
  value: BondLayoutInput;
  onChange: Dispatch<SetStateAction<BondLayoutInput>>;
  locked: boolean;
  onLockedChange: (locked: boolean) => void;
  lockToggleDisabled?: boolean;
}

const CALC_BASIS_OPTIONS: CalcBasis[] = [
  "미국 30/360",
  "ACT/ACT",
  "ACT/360",
  "ACT/365",
  "유럽 30/360",
  "Business/252",
];

const INVESTOR_TYPE_OPTIONS: InvestorType[] = ["개인", "일반법인", "금융법인"];

const TAX_STATUS_OPTIONS: TaxStatus[] = ["일반과세", "비과세(농특세)", "비과세"];

const COUPON_FREQUENCY_OPTIONS: CouponFrequency[] = ["3개월", "6개월", "12개월"];

const CURRENCY_OPTIONS: Currency[] = ["USD", "EUR", "CNY", "JPY", "KRW", "BRL"];

const cellBase = "flex items-center whitespace-nowrap px-3 py-2 print:py-1 text-sm border border-zinc-200 dark:border-zinc-800";
const labelCellClass = `${cellBase} bg-zinc-50 font-medium text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400`;
const valueCellClass = `${cellBase} bg-white dark:bg-zinc-950`;
const editableValueCellClass = `${cellBase} bg-orange-50 dark:bg-orange-950/30`;
const strongValueCellClass = `${cellBase} bg-orange-300 dark:bg-orange-800/70 print:bg-white dark:print:bg-white`;
const blankCellClass =
  "flex items-center whitespace-nowrap px-3 py-2 print:py-1 text-sm border border-white bg-white dark:border-zinc-950 dark:bg-zinc-950";
const inputClass =
  "w-full bg-transparent text-sm text-zinc-900 outline-none disabled:cursor-not-allowed disabled:text-zinc-400 dark:text-zinc-100 dark:disabled:text-zinc-600";

const PERCENT_INPUT_PATTERN = /^\d*(\.\d{0,2})?$/;

function selectAllOnFocus(e: FocusEvent<HTMLInputElement>) {
  e.target.select();
}

function commitOnEnter(e: KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter") {
    e.currentTarget.blur();
  }
}

/** 연도가 4자리를 넘어가면 마지막 4자리만 남긴다(예: 20275 -> 0275) */
function clampDateYear(raw: string): string {
  const match = raw.match(/^(\d+)-(\d{2})-(\d{2})$/);
  if (!match) return raw;
  const [, year, month, day] = match;
  if (year.length <= 4) return raw;
  return `${year.slice(-4)}-${month}-${day}`;
}

function formatTwoDecimals(raw: string): string {
  if (raw === "") return raw;
  const num = Number(raw);
  return Number.isNaN(num) ? raw : num.toFixed(2);
}

/** 선취보수(차감) = 신탁투자금액 x 선취보수율 */
function getFrontFeeAmount(
  trustInvestmentAmount: string,
  frontFeeRate: string
): number | null {
  if (!trustInvestmentAmount || !frontFeeRate) return null;
  const principal = Number(trustInvestmentAmount);
  const rate = Number(frontFeeRate);
  if (Number.isNaN(principal) || Number.isNaN(rate)) return null;
  return Math.trunc(principal * (rate / 100));
}

function Row({
  label,
  children,
  editable = false,
  blank = false,
  strong = false,
}: {
  label: string;
  children: ReactNode;
  editable?: boolean;
  blank?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="grid grid-cols-2">
      <div className={blank ? blankCellClass : labelCellClass}>{label}</div>
      <div
        className={
          blank
            ? blankCellClass
            : strong
              ? strongValueCellClass
              : editable
                ? editableValueCellClass
                : valueCellClass
        }
      >
        {children}
      </div>
    </div>
  );
}

function ComputedValue() {
  return (
    <span className="text-sm italic text-zinc-400 dark:text-zinc-600">
      자동계산
    </span>
  );
}

function BlankValue() {
  return <span>&nbsp;</span>;
}

/** 인쇄 시 select 대신 선택된 값만 텍스트로 보여준다 */
function PrintValue({ value }: { value: string }) {
  return <span className="hidden print:inline">{value}</span>;
}

function GroupCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="border border-b-0 border-zinc-200 bg-zinc-100 px-3 py-2 print:py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
        {title}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

export function BondLayoutForm({
  value,
  onChange,
  locked,
  onLockedChange,
  lockToggleDisabled = false,
}: BondLayoutFormProps) {
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [linkStatus, setLinkStatus] = useState<string | null>(null);
  const [activeSearchBox, setActiveSearchBox] = useState<
    "general" | "us" | "kr" | "br" | null
  >(null);
  // 신용등급이 SEC 공시서류(FWP) 기준 값인지(미국채권검색의 회사채만
  // 해당) 표시해 라벨을 "신용등급(공시기준)"으로 바꾸는 데 쓴다. 다른
  // 출처(국채/한국/브라질/종목검색/수기입력/업로드)로 바뀌면 false로
  // 되돌린다.
  const [disclosureRating, setDisclosureRating] = useState(false);

  const update = <K extends keyof BondLayoutInput>(
    key: K,
    val: BondLayoutInput[K]
  ) => onChange({ ...value, [key]: val });

  const pricing = useMemo(
    () =>
      computeBondPricing({
        maturityDate: value.maturityDate,
        couponRate: value.couponRate,
        couponFrequency: value.couponFrequency,
        purchaseYield: value.purchaseYield,
        calcBasis: value.calcBasis,
        trustContractDate: value.trustContractDate,
        recentCouponDate: value.recentCouponDate,
        tradeCurrency: value.tradeCurrency,
        custodyCurrency: value.custodyCurrency,
        purchaseFxRate: value.purchaseFxRate,
        trustInvestmentAmount: value.trustInvestmentAmount,
        frontFeeRate: value.frontFeeRate,
      }),
    [
      value.maturityDate,
      value.couponRate,
      value.couponFrequency,
      value.purchaseYield,
      value.calcBasis,
      value.trustContractDate,
      value.recentCouponDate,
      value.tradeCurrency,
      value.custodyCurrency,
      value.purchaseFxRate,
      value.trustInvestmentAmount,
      value.frontFeeRate,
    ]
  );

  const cashFlowRows = useMemo(
    () =>
      generateFixCashFlow({
        maturityDate: value.maturityDate,
        couponRate: value.couponRate,
        couponFrequency: value.couponFrequency,
        purchaseYield: value.purchaseYield,
        calcBasis: value.calcBasis,
        trustContractDate: value.trustContractDate,
        recentCouponDate: value.recentCouponDate,
        tradeCurrency: value.tradeCurrency,
        custodyCurrency: value.custodyCurrency,
        purchaseFxRate: value.purchaseFxRate,
        maturityFxRate: value.maturityFxRate,
        trustInvestmentAmount: value.trustInvestmentAmount,
        frontFeeRate: value.frontFeeRate,
        backFeeRate: value.backFeeRate,
        investorType: value.investorType,
        taxStatus: value.taxStatus,
      }),
    [
      value.maturityDate,
      value.couponRate,
      value.couponFrequency,
      value.purchaseYield,
      value.calcBasis,
      value.trustContractDate,
      value.recentCouponDate,
      value.tradeCurrency,
      value.custodyCurrency,
      value.purchaseFxRate,
      value.maturityFxRate,
      value.trustInvestmentAmount,
      value.frontFeeRate,
      value.backFeeRate,
      value.investorType,
      value.taxStatus,
    ]
  );

  const maturitySummary = useMemo(
    () =>
      pricing && cashFlowRows
        ? computeMaturitySummary(pricing, cashFlowRows, {
            trustContractDate: value.trustContractDate,
            maturityDate: value.maturityDate,
            trustInvestmentAmount: value.trustInvestmentAmount,
            backFeeRate: value.backFeeRate,
            tradeCurrency: value.tradeCurrency,
            custodyCurrency: value.custodyCurrency,
            maturityFxRate: value.maturityFxRate,
            comprehensiveTaxRate: value.incomeTaxRate,
          })
        : null,
    [
      pricing,
      cashFlowRows,
      value.trustContractDate,
      value.maturityDate,
      value.trustInvestmentAmount,
      value.backFeeRate,
      value.tradeCurrency,
      value.custodyCurrency,
      value.maturityFxRate,
      value.incomeTaxRate,
    ]
  );

  const handleUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseBondFile(buffer);
      const count = Object.keys(parsed).length;
      if (count === 0) {
        setUploadStatus("일치하는 항목을 찾지 못했습니다.");
        return;
      }
      onChange({ ...value, ...parsed });
      onLockedChange(true);
      setDisclosureRating(false);
      setUploadStatus(`${count}개 항목을 반영했습니다.`);
    } catch {
      setUploadStatus("파일을 읽는 중 오류가 발생했습니다.");
    }
  };

  const handleCreateLink = async () => {
    const link = encodeBondLink(value);
    try {
      await navigator.clipboard.writeText(link);
      setLinkStatus("링크를 클립보드에 복사했습니다.");
    } catch {
      setLinkStatus(link);
    }
  };

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950 sm:p-6 print:p-2">
      <div className="mb-5 flex items-center gap-3 print:hidden">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          입력 레이아웃
        </h2>
        {/* 업로드로 걸린 잠금(locked)에서는 검색창을 계속 쓸 수 있어야 다른
            종목을 검색해 새로 반영할 수 있다(검색으로 새 종목을 반영하면
            onLockedChange(false)로 잠금을 풀고, 다시 업로드하면
            handleUpload에서 다시 잠근다). 반면 공유 링크로 연 화면
            (lockToggleDisabled=isSharedLink)은 배포된 값을 그대로 봐야
            하므로 검색 자체를 막는다. */}
        <BondSearchBox
          disabled={lockToggleDisabled}
          active={activeSearchBox === "general"}
          onApply={(fields) => {
            setActiveSearchBox("general");
            onLockedChange(false);
            setDisclosureRating(false);
            onChange((prev) => applyFieldsWithCurrencySync(prev, fields));
          }}
        />
        <UsBondSearchBox
          disabled={lockToggleDisabled}
          active={activeSearchBox === "us"}
          onApply={(fields, meta) => {
            setActiveSearchBox("us");
            onLockedChange(false);
            if (meta?.disclosureRating !== undefined) {
              setDisclosureRating(meta.disclosureRating);
            }
            onChange((prev) => applyFieldsWithCurrencySync(prev, fields));
          }}
        />
        <KoreaBondSearchBox
          disabled={lockToggleDisabled}
          active={activeSearchBox === "kr"}
          onApply={(fields) => {
            setActiveSearchBox("kr");
            onLockedChange(false);
            setDisclosureRating(false);
            onChange((prev) => applyFieldsWithCurrencySync(prev, fields));
          }}
        />
        <BrazilBondSearchBox
          disabled={lockToggleDisabled}
          active={activeSearchBox === "br"}
          onApply={(fields) => {
            setActiveSearchBox("br");
            onLockedChange(false);
            setDisclosureRating(false);
            onChange((prev) => applyFieldsWithCurrencySync(prev, fields));
          }}
        />
      </div>

      {value.name && (
        <>
          <p className="hidden print:block text-[10pt]">&nbsp;</p>
          <p className="mb-4 print:mb-0 text-center text-[18pt] print:text-[30pt] print:tracking-normal font-bold underline text-zinc-900 dark:text-zinc-100">
            {`(${value.tradeCurrency}) ${value.name}`}
          </p>
          <p className="hidden print:block text-[10pt]">&nbsp;</p>
          <p className="hidden print:block text-[10pt]">&nbsp;</p>
        </>
      )}

      {/* 소득자구분 / 편입자산정보 공유 링크 */}
      <div className="mb-4 print:mb-1 grid grid-cols-1 gap-4 md:grid-cols-3 print:hidden">
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <Row label="소득자구분" editable>
            <select
              className={inputClass}
              value={value.investorType}
              onChange={(e) =>
                update("investorType", e.target.value as InvestorType)
              }
            >
              {INVESTOR_TYPE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </Row>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden md:col-span-2">
          <label className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800">
            업로드
            <input
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={handleUpload}
            />
          </label>
          <button
            type="button"
            onClick={handleCreateLink}
            className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            링크 생성
          </button>
          <button
            type="button"
            disabled={lockToggleDisabled}
            onClick={() => onLockedChange(!locked)}
            className={
              locked
                ? "inline-flex w-fit items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400 dark:disabled:hover:bg-amber-950/40"
                : "inline-flex w-fit items-center gap-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-white dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:disabled:hover:bg-zinc-900"
            }
          >
            {locked ? "🔒 편입자산정보 잠김 (해제)" : "🔓 편입자산정보 잠금"}
          </button>
          {(uploadStatus || linkStatus) && (
            <p className="ml-2 whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400">
              {uploadStatus || linkStatus}
            </p>
          )}
        </div>
      </div>

      {/* 편입자산정보 / 매수내역 / 상품수익률 */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 print:grid-cols-3 print:gap-2">
        <GroupCard title="편입자산정보">
          <Row label="종목명" editable>
            <input
              className={inputClass}
              type="text"
              placeholder="예: KORELE 7.95 04/01/2096"
              value={value.name}
              disabled={locked}
              onChange={(e) => update("name", e.target.value)}
              onKeyDown={commitOnEnter}
            />
          </Row>
          <Row label="발행일" editable>
            <input
              className={inputClass}
              type="date"
              value={value.issueDate}
              disabled={locked}
              onChange={(e) => update("issueDate", clampDateYear(e.target.value))}
              onKeyDown={commitOnEnter}
            />
          </Row>
          <Row label="만기일" editable>
            <input
              className={inputClass}
              type="date"
              value={value.maturityDate}
              disabled={locked}
              onChange={(e) => update("maturityDate", clampDateYear(e.target.value))}
              onKeyDown={commitOnEnter}
            />
          </Row>
          <Row label="표면이율(%)" editable>
            <input
              className={inputClass}
              type="text"
              inputMode="decimal"
              placeholder="예: 7.95"
              value={value.couponRate}
              disabled={locked}
              onFocus={selectAllOnFocus}
              onChange={(e) => {
                if (PERCENT_INPUT_PATTERN.test(e.target.value)) {
                  update("couponRate", e.target.value);
                }
              }}
              onBlur={(e) => update("couponRate", formatTwoDecimals(e.target.value))}
              onKeyDown={commitOnEnter}
            />
          </Row>
          <Row label="이자지급 주기" editable>
            <select
              className={`${inputClass} print:hidden`}
              value={value.couponFrequency}
              disabled={locked}
              onChange={(e) =>
                update("couponFrequency", e.target.value as CouponFrequency)
              }
            >
              {COUPON_FREQUENCY_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <PrintValue value={value.couponFrequency} />
          </Row>
          <Row label="최근이표일" editable>
            <input
              className={inputClass}
              type="date"
              value={
                value.recentCouponDate ||
                getRecentCouponDate(
                  value.maturityDate,
                  value.couponFrequency,
                  getSettlementDate(value.trustContractDate, value.calcBasis) ??
                    undefined
                ) ||
                ""
              }
              disabled={locked}
              onChange={(e) =>
                update("recentCouponDate", clampDateYear(e.target.value))
              }
              onKeyDown={commitOnEnter}
            />
          </Row>
          <Row label="날짜계산 기준" editable>
            <select
              className={`${inputClass} print:hidden`}
              value={value.calcBasis}
              disabled={locked}
              onChange={(e) =>
                update("calcBasis", e.target.value as CalcBasis)
              }
            >
              {CALC_BASIS_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <PrintValue value={value.calcBasis} />
          </Row>
          <Row label={disclosureRating ? "신용등급(공시기준)" : "신용등급"} editable>
            <input
              className={inputClass}
              type="text"
              placeholder="예: 무디스: Aa2 / S&P: AA"
              value={value.creditRating}
              disabled={locked}
              onChange={(e) => {
                setDisclosureRating(false);
                update("creditRating", e.target.value);
              }}
              onKeyDown={commitOnEnter}
            />
          </Row>
          <Row label="과세여부" editable>
            <select
              className={`${inputClass} print:hidden`}
              value={value.taxStatus}
              disabled={locked}
              onChange={(e) =>
                update("taxStatus", e.target.value as TaxStatus)
              }
            >
              {TAX_STATUS_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <PrintValue value={value.taxStatus} />
          </Row>
          <Row label=" " blank>
            <BlankValue />
          </Row>
          <Row label="거래통화" editable>
            <select
              className={`${inputClass} print:hidden`}
              value={value.tradeCurrency}
              onChange={(e) => {
                const tradeCurrency = e.target.value as Currency;
                if (tradeCurrency === value.custodyCurrency) {
                  onChange({
                    ...value,
                    tradeCurrency,
                    purchaseFxRate: "1",
                    maturityFxRate: "1",
                    trustInvestmentAmount:
                      tradeCurrency === "KRW" ? "100000000" : "1000000",
                  });
                  return;
                }
                onChange({
                  ...value,
                  tradeCurrency,
                  custodyCurrency: tradeCurrency,
                  purchaseFxRate: "1",
                  maturityFxRate: "1",
                  trustInvestmentAmount:
                    tradeCurrency === "KRW" ? "100000000" : "1000000",
                });
              }}
            >
              {CURRENCY_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <PrintValue value={value.tradeCurrency} />
          </Row>
          <Row label="수탁통화" editable>
            <select
              className={`${inputClass} print:hidden`}
              value={value.custodyCurrency}
              onChange={(e) => {
                const custodyCurrency = e.target.value as Currency;
                if (custodyCurrency === value.tradeCurrency) {
                  onChange({
                    ...value,
                    custodyCurrency,
                    purchaseFxRate: "1",
                    maturityFxRate: "1",
                    trustInvestmentAmount:
                      custodyCurrency === "KRW" ? "100000000" : "1000000",
                  });
                  return;
                }
                onChange({
                  ...value,
                  custodyCurrency,
                  purchaseFxRate: "",
                  maturityFxRate: "",
                  trustInvestmentAmount:
                    custodyCurrency === "KRW" ? "100000000" : "1000000",
                });
                // 거래통화와 수탁통화가 달라지면 환율을 직접 입력해야 하던
                // 것을, 현재 환율을 자동 조회해 기본값으로 채워 넣는다
                // (필요하면 사용자가 직접 수정 가능).
                const tradeCurrency = value.tradeCurrency;
                fetch(
                  `/api/fx-rate?base=${encodeURIComponent(tradeCurrency)}&quote=${encodeURIComponent(custodyCurrency)}`
                )
                  .then((res) => res.json())
                  .then((data: { rate?: number | null }) => {
                    if (typeof data.rate === "number") {
                      const rate = String(data.rate);
                      onChange((prev) =>
                        prev.tradeCurrency === tradeCurrency &&
                        prev.custodyCurrency === custodyCurrency
                          ? { ...prev, purchaseFxRate: rate, maturityFxRate: rate }
                          : prev
                      );
                    }
                  })
                  .catch(() => {});
              }}
            >
              {CURRENCY_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <PrintValue value={value.custodyCurrency} />
          </Row>
        </GroupCard>

        <GroupCard title="매수내역">
          <Row label="신탁투자금액" editable>
            <input
              className={inputClass}
              type="text"
              inputMode="numeric"
              placeholder="예: 1,000,000"
              value={
                value.trustInvestmentAmount === ""
                  ? ""
                  : Number(value.trustInvestmentAmount).toLocaleString(
                      "ko-KR"
                    )
              }
              onFocus={selectAllOnFocus}
              onChange={(e) => {
                const digits = e.target.value.replace(/,/g, "");
                if (/^\d*$/.test(digits)) {
                  update("trustInvestmentAmount", digits);
                }
              }}
              onKeyDown={commitOnEnter}
            />
          </Row>
          <Row label="선취보수(차감)">
            {(() => {
              const amount = getFrontFeeAmount(
                value.trustInvestmentAmount,
                value.frontFeeRate
              );
              return amount !== null ? (
                <span className="text-sm text-zinc-900 dark:text-zinc-100">
                  {amount.toLocaleString("ko-KR")}
                </span>
              ) : (
                <ComputedValue />
              );
            })()}
          </Row>
          <Row label="매수가능금액">
            {(() => {
              const frontFee = getFrontFeeAmount(
                value.trustInvestmentAmount,
                value.frontFeeRate
              );
              if (frontFee === null) return <ComputedValue />;
              const available = Number(value.trustInvestmentAmount) - frontFee;
              return (
                <span className="text-sm text-zinc-900 dark:text-zinc-100">
                  {available.toLocaleString("ko-KR")}
                </span>
              );
            })()}
          </Row>
          <Row label="채권권면액">
            {pricing ? (
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                {formatAmount(pricing.faceValue)}
              </span>
            ) : (
              <ComputedValue />
            )}
          </Row>
          <Row label="매수단가(clean)">
            {pricing ? (
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                {pricing.cleanPrice.toFixed(4)}
              </span>
            ) : (
              <ComputedValue />
            )}
          </Row>
          <Row label="매수단가(dirty)">
            {pricing ? (
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                {pricing.dirtyPrice.toFixed(4)}
              </span>
            ) : (
              <ComputedValue />
            )}
          </Row>
          <Row label="매수금리(YTM)" strong>
            <input
              className={`${inputClass} font-bold`}
              type="text"
              inputMode="decimal"
              placeholder="예: 5.30"
              value={value.purchaseYield}
              onFocus={selectAllOnFocus}
              onChange={(e) => {
                if (PERCENT_INPUT_PATTERN.test(e.target.value)) {
                  update("purchaseYield", e.target.value);
                }
              }}
              onBlur={(e) =>
                update("purchaseYield", formatTwoDecimals(e.target.value))
              }
              onKeyDown={commitOnEnter}
            />
          </Row>
          <Row
            label={
              value.tradeCurrency === "KRW"
                ? "경과이자"
                : value.calcBasis === "Business/252"
                  ? "경과이자(1000BRL)"
                  : "경과이자(100$)"
            }
          >
            {pricing ? (
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                {formatAmount(pricing.accruedInterest)}
              </span>
            ) : (
              <ComputedValue />
            )}
          </Row>
          <Row label="결제금액">
            {pricing ? (
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                {formatSettlementAmount(
                  pricing.settlementAmount,
                  value.custodyCurrency === "KRW"
                )}
              </span>
            ) : (
              <ComputedValue />
            )}
          </Row>
          <Row label="현금잔액">
            {pricing ? (
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                {formatSettlementAmount(
                  pricing.cashBalance,
                  value.custodyCurrency === "KRW"
                )}
              </span>
            ) : (
              <ComputedValue />
            )}
          </Row>
          <Row label="매수시점환율" editable>
            <input
              className={inputClass}
              type="text"
              inputMode="decimal"
              placeholder="예: 1449.60"
              value={value.purchaseFxRate}
              disabled={value.custodyCurrency === value.tradeCurrency}
              onFocus={selectAllOnFocus}
              onChange={(e) => {
                if (PERCENT_INPUT_PATTERN.test(e.target.value)) {
                  update("purchaseFxRate", e.target.value);
                }
              }}
              onBlur={(e) => {
                const formatted = formatTwoDecimals(e.target.value);
                if (value.custodyCurrency !== value.tradeCurrency) {
                  onChange({
                    ...value,
                    purchaseFxRate: formatted,
                    maturityFxRate: formatted,
                  });
                } else {
                  update("purchaseFxRate", formatted);
                }
              }}
              onKeyDown={commitOnEnter}
            />
          </Row>
          <Row label="만기예상환율(예상)" editable>
            <input
              className={inputClass}
              type="text"
              inputMode="decimal"
              placeholder="예: 1449.60"
              value={value.maturityFxRate}
              disabled={value.custodyCurrency === value.tradeCurrency}
              onFocus={selectAllOnFocus}
              onChange={(e) => {
                if (PERCENT_INPUT_PATTERN.test(e.target.value)) {
                  update("maturityFxRate", e.target.value);
                }
              }}
              onBlur={(e) =>
                update("maturityFxRate", formatTwoDecimals(e.target.value))
              }
              onKeyDown={commitOnEnter}
            />
          </Row>
        </GroupCard>

        <GroupCard title="상품수익률">
          <Row label="신탁계약일" editable>
            <input
              className={inputClass}
              type="date"
              value={value.trustContractDate}
              onChange={(e) =>
                update("trustContractDate", clampDateYear(e.target.value))
              }
              onKeyDown={commitOnEnter}
            />
          </Row>
          <Row label="신탁만기일">
            {getTrustMaturityDate(value.maturityDate) ? (
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                {getTrustMaturityDate(value.maturityDate)}
              </span>
            ) : (
              <ComputedValue />
            )}
          </Row>
          <Row label="투자일수">
            {(() => {
              const days = getInvestmentDays(
                value.trustContractDate,
                value.maturityDate
              );
              return days !== null ? (
                <span className="text-sm text-zinc-900 dark:text-zinc-100">
                  {days.toLocaleString("ko-KR")}일
                </span>
              ) : (
                <ComputedValue />
              );
            })()}
          </Row>
          <Row label="선취보수율(%)" editable>
            <input
              className={inputClass}
              type="text"
              inputMode="decimal"
              placeholder="예: 2.5"
              value={value.frontFeeRate}
              onFocus={selectAllOnFocus}
              onChange={(e) => {
                if (PERCENT_INPUT_PATTERN.test(e.target.value)) {
                  update("frontFeeRate", e.target.value);
                }
              }}
              onBlur={(e) =>
                update("frontFeeRate", formatTwoDecimals(e.target.value))
              }
              onKeyDown={commitOnEnter}
            />
          </Row>
          <Row label="후취보수율(%)" editable>
            <input
              className={inputClass}
              type="text"
              inputMode="decimal"
              placeholder="예: 0.5"
              value={value.backFeeRate}
              onFocus={selectAllOnFocus}
              onChange={(e) => {
                if (PERCENT_INPUT_PATTERN.test(e.target.value)) {
                  update("backFeeRate", e.target.value);
                }
              }}
              onKeyDown={commitOnEnter}
              onBlur={(e) =>
                update("backFeeRate", formatTwoDecimals(e.target.value))
              }
            />
          </Row>
          <Row label="만기시 세전금액">
            {maturitySummary ? (
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                {formatSettlementAmount(
                  maturitySummary.preTaxMaturityAmount,
                  value.custodyCurrency === "KRW"
                )}
              </span>
            ) : (
              <ComputedValue />
            )}
          </Row>
          <Row label="마지막 후취보수">
            {maturitySummary ? (
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                {formatAmount(maturitySummary.lastBackFee)}
              </span>
            ) : (
              <ComputedValue />
            )}
          </Row>
          <Row label="만기시 세후금액">
            {maturitySummary ? (
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                {formatSettlementAmount(
                  maturitySummary.postTaxMaturityAmount,
                  value.custodyCurrency === "KRW"
                )}
              </span>
            ) : (
              <ComputedValue />
            )}
          </Row>
          <Row label="세전수익률">
            {maturitySummary ? (
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                {(maturitySummary.preTaxYield * 100).toFixed(2)}%
              </span>
            ) : (
              <ComputedValue />
            )}
          </Row>
          <Row label="세후수익률">
            {maturitySummary ? (
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                {(maturitySummary.postTaxYield * 100).toFixed(2)}%
              </span>
            ) : (
              <ComputedValue />
            )}
          </Row>
          <Row label="종합소득세율(%)" editable>
            <input
              className={inputClass}
              type="text"
              inputMode="decimal"
              placeholder="예: 15.4"
              value={value.incomeTaxRate}
              onFocus={selectAllOnFocus}
              onChange={(e) => {
                if (PERCENT_INPUT_PATTERN.test(e.target.value)) {
                  update("incomeTaxRate", e.target.value);
                }
              }}
              onBlur={(e) =>
                update("incomeTaxRate", formatTwoDecimals(e.target.value))
              }
              onKeyDown={commitOnEnter}
            />
          </Row>
          <Row label="은행환산수익률">
            {maturitySummary ? (
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                {(maturitySummary.bankEquivalentYield * 100).toFixed(2)}%
              </span>
            ) : (
              <ComputedValue />
            )}
          </Row>
        </GroupCard>
      </div>
    </section>
  );
}
