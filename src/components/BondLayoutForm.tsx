"use client";

import {
  ChangeEvent,
  Dispatch,
  FocusEvent,
  KeyboardEvent,
  ReactNode,
  SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BondLayoutInput,
  CalcBasis,
  CallScenario,
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
  getTrustMaturityLeadDays,
  toDateString,
} from "@/lib/couponSchedule";
import { getDefaultSettlementDays, resolveSettlementDays } from "@/lib/settlementCalendar";
import {
  computeBondPricing,
  getEffectiveRedemption,
  getMakeWholeDiscountHorizon,
} from "@/lib/bondPricing";
import { generateFixCashFlow } from "@/lib/cashFlowSchedule";
import {
  interpolateTreasuryRate,
  type TreasuryParYieldCurve as YieldCurve,
} from "@/lib/yieldCurve";
import { computeMaturitySummary } from "@/lib/maturitySummary";
import { parseBondFile } from "@/lib/parseBondFile";
import { encodeBondLink } from "@/lib/bondLink";
import { BondSearchBox } from "@/components/BondSearchBox";
import { UsBondSearchBox } from "@/components/UsBondSearchBox";
import { KoreaBondSearchBox } from "@/components/KoreaBondSearchBox";

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
/**
 * 만기일이 새 종목 값으로 바뀔 때, 이전 종목에 걸려 있던 신탁만기일 수기
 * override·콜조항 필드를 기본값으로 되돌린다. incoming이 해당 키를 이미
 * 명시했으면 건드리지 않는다.
 */
function clearedCallFields(
  incoming: Partial<BondLayoutInput>
): Partial<BondLayoutInput> {
  const cleared: Partial<BondLayoutInput> = {};
  if (incoming.trustMaturityDate === undefined) cleared.trustMaturityDate = "";
  if (incoming.hasCall === undefined) cleared.hasCall = false;
  if (incoming.parCallDate === undefined) cleared.parCallDate = "";
  if (incoming.makeWholeSpreadBps === undefined) cleared.makeWholeSpreadBps = "";
  if (incoming.callScenario === undefined) cleared.callScenario = "hold";
  if (incoming.makeWholeRedemptionDate === undefined)
    cleared.makeWholeRedemptionDate = "";
  if (incoming.makeWholeRefYield === undefined) cleared.makeWholeRefYield = "";
  if (incoming.isin === undefined) cleared.isin = "";
  return cleared;
}

function applyFieldsWithCurrencySync(
  value: BondLayoutInput,
  incomingFields: Partial<BondLayoutInput>
): BondLayoutInput {
  // 다른 종목을 반영해 만기일이 바뀌면, 이전 종목에 걸어둔 신탁만기일 수기
  // 수정값·콜조항은 무의미하므로 초기화한다(검색 쪽이 값을 명시한 경우 제외).
  const fields =
    incomingFields.maturityDate !== undefined
      ? { ...clearedCallFields(incomingFields), ...incomingFields }
      : incomingFields;
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

/** 두 ISO 날짜 사이 연수 (365.25일 기준) */
function yearsBetweenIso(from: string, to: string): number | null {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
  return (b - a) / (365.25 * 24 * 60 * 60 * 1000);
}

const CALL_SCENARIO_LABELS: { value: CallScenario; label: string }[] = [
  { value: "hold", label: "만기보유" },
  { value: "parCall", label: "Par Call 행사" },
  { value: "makeWhole", label: "Make-Whole 상환" },
];

/** 공시서류 자동추출(추정) 안내문 — 원문 발췌를 함께 보여준다. */
function autoTermsNoteText(redemptionText?: string | null): string {
  const excerpt = redemptionText ?? "";
  return excerpt
    ? `공시서류 자동추출값(추정) — 원문 확인 필요. 발췌: "${excerpt.slice(0, 200)}${
        excerpt.length > 200 ? "…" : ""
      }"`
    : "공시서류 자동추출값(추정) — 원문 확인 필요.";
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

// 일반 행 높이 = text-sm 줄높이 20px + py-2 16px + 상하 테두리 2px = 38px
// (인쇄는 py-1 → 30px). tall 행은 정확히 두 행 높이로 고정해 옆 카드의 두 행
// (거래통화+수탁통화)과 줄이 맞게 한다 — 두 행 자체는 손대지 않는다.
const tallRowClass = "min-h-[76px] print:min-h-[60px]";

function Row({
  label,
  children,
  editable = false,
  blank = false,
  strong = false,
  tall = false,
}: {
  label: ReactNode;
  children: ReactNode;
  editable?: boolean;
  blank?: boolean;
  strong?: boolean;
  /** 두 행 높이(거래통화+수탁통화)로 고정 */
  tall?: boolean;
}) {
  const extra = tall ? ` ${tallRowClass}` : "";
  return (
    <div className="grid grid-cols-2">
      <div className={(blank ? blankCellClass : labelCellClass) + extra}>{label}</div>
      <div
        className={
          (blank
            ? blankCellClass
            : strong
              ? strongValueCellClass
              : editable
                ? editableValueCellClass
                : valueCellClass) + extra
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
    "general" | "us" | "kr" | null
  >(null);
  // 신용등급이 SEC 공시서류(FWP) 기준 값인지(미국채권검색의 회사채만
  // 해당) 표시해 라벨을 "신용등급(공시기준)"으로 바꾸는 데 쓴다. 다른
  // 출처(국채/한국/브라질/종목검색/수기입력/업로드)로 바뀌면 false로
  // 되돌린다.
  const [disclosureRating, setDisclosureRating] = useState(false);
  // 콜조항이 공시서류 자동추출값(추정)일 때 화면에 띄울 안내(원문 발췌 포함).
  // 사용자가 직접 고치거나 종목이 바뀌면 지운다(Opus #10).
  const [autoTermsNote, setAutoTermsNote] = useState<string | null>(null);
  const [treasuryCurve, setTreasuryCurve] = useState<YieldCurve | null>(null);
  const [treasuryStatus, setTreasuryStatus] = useState<string | null>(null);
  // 콜조항 체크박스 재조회(검색 없이 켤 때) 상태 문구.
  // 콜조항 재조회 결과의 짧은 안내. 폼 행이 아니라 종목을 반영한 검색창
  // (종목검색/미국채권검색/한국채권검색) 옆에 표시한다(사용자 지시).
  const [callNotice, setCallNotice] = useState<string | null>(null);
  // 결제일수 입력 중인 임시값. 엔터로만 확정되고, 엔터 없이 떠나면 버린다
  // (사용자 지시: "엔터를 누르지 않으면 디폴트").
  const [settlementDraft, setSettlementDraft] = useState<string | null>(null);
  // 비동기 응답(국채곡선 보간 등)이 돌아왔을 때 그 사이 입력이 바뀌었는지
  // 확인하기 위한 최신 value 스냅샷.
  const latestValue = useRef(value);
  useEffect(() => {
    latestValue.current = value;
  });

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
        settlementDays: value.settlementDays,
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
      value.settlementDays,
    ]
  );

  // 콜/조기상환 시나리오의 실효 원금상환일·상환배수. hold이면 만기·배수 1.
  const effectiveRedemption = useMemo(
    () =>
      getEffectiveRedemption({
        hasCall: value.hasCall,
        callScenario: value.callScenario,
        maturityDate: value.maturityDate,
        parCallDate: value.parCallDate,
        makeWholeRedemptionDate: value.makeWholeRedemptionDate,
        makeWholeRefYield: value.makeWholeRefYield,
        makeWholeSpreadBps: value.makeWholeSpreadBps,
        couponRate: value.couponRate,
        couponFrequency: value.couponFrequency,
        calcBasis: value.calcBasis,
        tradeCurrency: value.tradeCurrency,
        trustContractDate: value.trustContractDate,
        settlementDays: value.settlementDays,
      }),
    [
      value.hasCall,
      value.callScenario,
      value.maturityDate,
      value.parCallDate,
      value.makeWholeRedemptionDate,
      value.makeWholeRefYield,
      value.makeWholeSpreadBps,
      value.couponRate,
      value.couponFrequency,
      value.calcBasis,
      value.tradeCurrency,
      value.trustContractDate,
      value.settlementDays,
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
        hasCall: value.hasCall,
        callScenario: value.callScenario,
        parCallDate: value.parCallDate,
        makeWholeRedemptionDate: value.makeWholeRedemptionDate,
        makeWholeRefYield: value.makeWholeRefYield,
        makeWholeSpreadBps: value.makeWholeSpreadBps,
        settlementDays: value.settlementDays,
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
      value.hasCall,
      value.callScenario,
      value.parCallDate,
      value.makeWholeRedemptionDate,
      value.makeWholeRefYield,
      value.makeWholeSpreadBps,
      value.settlementDays,
    ]
  );

  const maturitySummary = useMemo(
    () =>
      cashFlowRows && pricing
        ? computeMaturitySummary(cashFlowRows, {
            trustContractDate: value.trustContractDate,
            maturityDate: value.maturityDate,
            redemptionDate: effectiveRedemption.redemptionDate,
            trustMaturityDate: value.trustMaturityDate,
            trustInvestmentAmount: value.trustInvestmentAmount,
            backFeeRate: value.backFeeRate,
            cashBalance: pricing.cashBalance,
            comprehensiveTaxRate: value.incomeTaxRate,
          })
        : null,
    [
      cashFlowRows,
      pricing,
      value.trustContractDate,
      value.maturityDate,
      effectiveRedemption.redemptionDate,
      value.trustMaturityDate,
      value.trustInvestmentAmount,
      value.backFeeRate,
      value.incomeTaxRate,
    ]
  );

  // make-whole 기준 국채금리 자동채움: 국채곡선을 받아 (상환일~PV지평) 잔존만기로
  // 보간해 makeWholeRefYield에 넣는다. PV지평은 par call일이 있으면 그 날짜다
  // (make-whole 상환가 계산과 동일 기준 — 감사 #2).
  //
  // - force=false: 이미 값이 있으면 건드리지 않음(시나리오 최초 선택 시).
  // - force=true: 상환일·par call일이 바뀌면 잔존만기가 달라지므로 항상 재보간
  //   (감사 F8 — 이전엔 값이 있으면 그대로 둬 5y 금리가 2y 상환에 남았다).
  // - 결과 반영은 functional update로 makeWholeRefYield만 병합하고, 요청
  //   시점의 날짜·시나리오가 그 사이 바뀌었으면 폐기한다(stale closure로
  //   다른 입력을 덮어쓰던 문제).
  const applyMakeWholeRate = async (next: BondLayoutInput, force: boolean) => {
    if (next.callScenario !== "makeWhole") return;
    if (!next.makeWholeRedemptionDate || !next.maturityDate) return;
    if (!force && next.makeWholeRefYield.trim() !== "") return;
    const horizon = getMakeWholeDiscountHorizon(
      next.maturityDate,
      next.parCallDate,
      next.makeWholeRedemptionDate
    );
    const years = yearsBetweenIso(next.makeWholeRedemptionDate, horizon);
    if (years === null) return;

    let curve = treasuryCurve;
    if (!curve) {
      try {
        const res = await fetch("/api/treasury-yield");
        if (!res.ok) throw new Error();
        curve = (await res.json()) as YieldCurve;
        setTreasuryCurve(curve);
      } catch {
        setTreasuryStatus(
          "국채 수익률곡선을 불러오지 못했습니다. 기준금리를 직접 입력하세요."
        );
        return;
      }
    }
    const rate = interpolateTreasuryRate(curve, years);
    if (rate === null) return;
    // 곡선 fetch 동안 상환일·par call일·만기·시나리오가 바뀌었으면 이 결과는
    // 다른 잔존만기에 대한 값이므로 폐기한다.
    const now = latestValue.current;
    const stillSame =
      now.callScenario === "makeWhole" &&
      now.makeWholeRedemptionDate === next.makeWholeRedemptionDate &&
      now.parCallDate === next.parCallDate &&
      now.maturityDate === next.maturityDate;
    if (!stillSame) return;
    setTreasuryStatus(
      `${curve.date} 국채곡선 · 잔존 ${years.toFixed(1)}년 보간값`
    );
    const refYield = rate.toFixed(3);
    onChange((prev) => ({ ...prev, makeWholeRefYield: refYield }));
  };

  // 콜조항 체크박스 재조회: 검색을 거치지 않고 체크박스를 켤 때 이미 반영된
  // ISIN으로 공시서류를 다시 조회한다. next를 받아 한 번의 onChange로 반영해
  // 동시 입력을 덮어쓰지 않는다.
  const verifyCallTerms = async (next: BondLayoutInput) => {
    if (!next.isin) {
      setCallNotice("콜옵션 확인불가");
      return;
    }
    setCallNotice("콜옵션 확인 중");
    try {
      const res = await fetch(
        `/api/us-bond-terms?isin=${encodeURIComponent(next.isin)}`
      );
      const data = (await res.json()) as {
        found?: boolean;
        tranche?: {
          parCallDate: string | null;
          makeWholeSpreadBps: number | null;
          callAbsentConfirmed?: boolean;
          redemptionText?: string | null;
        };
      };
      // 응답이 오는 동안 종목이 바뀌었거나(ISIN 불일치) 사용자가 체크를
      // 이미 껐으면 이 결과는 폐기한다 — stale closure로 되살리거나 다른
      // 입력을 덮어쓰지 않도록(감사 F5).
      const now = latestValue.current;
      if (now.isin !== next.isin || !now.hasCall) return;

      if (!res.ok || !data.found || !data.tranche) {
        setCallNotice("콜옵션 확인불가");
        return;
      }
      const t = data.tranche;
      const found = t.parCallDate !== null || t.makeWholeSpreadBps !== null;
      if (found) {
        onChange((prev) => ({
          ...prev,
          parCallDate: t.parCallDate ?? prev.parCallDate,
          makeWholeSpreadBps:
            t.makeWholeSpreadBps != null
              ? String(t.makeWholeSpreadBps)
              : prev.makeWholeSpreadBps,
        }));
        setCallNotice(null);
        setAutoTermsNote(autoTermsNoteText(t.redemptionText));
      } else if (t.callAbsentConfirmed) {
        // 문서가 "콜 없음"을 명시한 경우에만 경고 + 체크 해제.
        onChange((prev) => ({
          ...prev,
          hasCall: false,
          callScenario:
            prev.callScenario === "parCall" || prev.callScenario === "makeWhole"
              ? "hold"
              : prev.callScenario,
        }));
        setCallNotice("콜옵션 없음");
      } else {
        // 문서는 찾았지만 조항을 못 읽음(서식 미지원 등) — "없음"으로 단정하지 않는다.
        setCallNotice("콜옵션 확인불가");
      }
    } catch {
      setCallNotice("콜옵션 확인불가");
    }
  };

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
      // 만기일이 새로 들어왔으면 이전 종목의 신탁만기일 override·콜조항을 초기화.
      const merged =
        parsed.maturityDate !== undefined
          ? { ...value, ...clearedCallFields(parsed), ...parsed }
          : { ...value, ...parsed };
      onChange(merged);
      onLockedChange(true);
      setDisclosureRating(false);
      setAutoTermsNote(null);
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
          notice={callNotice}
          onApply={(fields) => {
            setActiveSearchBox("general");
            setCallNotice(null);
            onLockedChange(false);
            setDisclosureRating(false);
            setAutoTermsNote(null);
            onChange((prev) => applyFieldsWithCurrencySync(prev, fields));
          }}
        />
        <UsBondSearchBox
          disabled={lockToggleDisabled}
          active={activeSearchBox === "us"}
          notice={callNotice}
          onApply={(fields, meta) => {
            setActiveSearchBox("us");
            setCallNotice(null);
            onLockedChange(false);
            if (meta?.disclosureRating !== undefined) {
              setDisclosureRating(meta.disclosureRating);
            }
            if (meta?.callTermsAuto !== undefined) {
              setAutoTermsNote(
                meta.callTermsAuto
                  ? autoTermsNoteText(meta.redemptionText)
                  : null
              );
            }
            onChange((prev) => applyFieldsWithCurrencySync(prev, fields));
          }}
        />
        <KoreaBondSearchBox
          disabled={lockToggleDisabled}
          active={activeSearchBox === "kr"}
          notice={callNotice}
          onApply={(fields) => {
            setActiveSearchBox("kr");
            setCallNotice(null);
            onLockedChange(false);
            setDisclosureRating(false);
            setAutoTermsNote(null);
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

      {/* 소득자구분 / 결제일 / 업로드·링크·정보잠금 — 3열 그리드라 아래 카드
          (편입자산정보·매수내역·상품수익률)와 열이 맞는다. */}
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
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <Row
            // 결제일수는 달력이 아니라 숫자(T+n 영업일)로 입력한다 — 규칙상 T+1
            // 이라도 상대방 숏커버 지연으로 결제가 늦어지는 일이 잦아 "5"처럼
            // 실제 영업일수를 적는 편이 빠르다(사용자 지시). 비우면 시장 관행.
            label={
              <span className="flex items-center gap-2">
                결제일
                {value.settlementDays.trim() !== "" ? (
                  <button
                    type="button"
                    onClick={() => update("settlementDays", "")}
                    title="수기값을 지우고 시장 관행(미국 T+1·그 외 T+2)으로 되돌립니다"
                    className="shrink-0 rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] font-normal text-zinc-500 hover:bg-white dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900 print:hidden"
                  >
                    자동
                  </button>
                ) : (
                  <span
                    title="시장 관행: 미국 T+1 · 그 외 T+2 (거래통화 시장 휴장일 반영)"
                    className="shrink-0 text-[11px] font-normal italic text-zinc-400 dark:text-zinc-600 print:hidden"
                  >
                    자동
                  </span>
                )}
              </span>
            }
            editable
          >
            {(() => {
              const days = resolveSettlementDays(
                value.settlementDays,
                value.calcBasis,
                value.tradeCurrency
              );
              const settlement = getSettlementDate(
                value.trustContractDate,
                value.calcBasis,
                value.tradeCurrency,
                value.settlementDays
              );
              return (
                <span className="flex items-center gap-1 text-sm text-zinc-900 dark:text-zinc-100">
                  <span className="shrink-0 text-zinc-500 dark:text-zinc-400">T+</span>
                  <input
                    className={`${inputClass} w-8 shrink-0 print:hidden`}
                    type="text"
                    inputMode="numeric"
                    value={
                      settlementDraft ??
                      (value.settlementDays === "" ? String(days) : value.settlementDays)
                    }
                    onFocus={selectAllOnFocus}
                    onChange={(e) => {
                      if (/^\d{0,2}$/.test(e.target.value)) {
                        setSettlementDraft(e.target.value);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      if (settlementDraft !== null) {
                        // 시장 관행값과 같으면 빈 값(자동)으로 저장해 "자동" 배지를 유지한다.
                        const defaultDays = String(
                          getDefaultSettlementDays(value.calcBasis, value.tradeCurrency)
                        );
                        update(
                          "settlementDays",
                          settlementDraft === "" || settlementDraft === defaultDays
                            ? ""
                            : settlementDraft
                        );
                      }
                      setSettlementDraft(null);
                      e.currentTarget.blur();
                    }}
                    onBlur={() => setSettlementDraft(null)}
                  />
                  <span className="hidden print:inline">{days}</span>
                  <span className="shrink-0">
                    ({settlement ? toDateString(settlement) : "-"})
                  </span>
                </span>
              );
            })()}
          </Row>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
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
            {locked ? "🔒 정보잠김 (해제)" : "🔓 정보잠금"}
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
              onChange={(e) => {
                // 만기일을 수기로 바꾸면 이전 종목의 콜/ISIN·신탁만기일 override는
                // 무의미하므로 검색/업로드 경로와 동일하게 초기화한다(감사 F7).
                setAutoTermsNote(null);
                onChange({
                  ...value,
                  ...clearedCallFields({}),
                  maturityDate: clampDateYear(e.target.value),
                });
              }}
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
                  getSettlementDate(
                    value.trustContractDate,
                    value.calcBasis,
                    value.tradeCurrency,
                    value.settlementDays
                  ) ?? undefined
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
          <Row label="콜조항" editable>
            <label className="flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100">
              <input
                type="checkbox"
                className="h-4 w-4 accent-orange-600"
                checked={value.hasCall}
                onChange={(e) => {
                  const checked = e.target.checked;
                  const next = {
                    ...value,
                    hasCall: checked,
                    callScenario:
                      !checked &&
                      (value.callScenario === "parCall" ||
                        value.callScenario === "makeWhole")
                        ? ("hold" as CallScenario)
                        : value.callScenario,
                  };
                  onChange(next);
                  if (checked) void verifyCallTerms(next);
                  else setCallNotice(null);
                }}
              />
              <span>{value.hasCall ? "있음" : "없음"}</span>
            </label>
          </Row>

          {value.hasCall && (
            <>
              <Row label="Par Call일" editable>
                <input
                  className={inputClass}
                  type="date"
                  value={value.parCallDate}
                  onChange={(e) => {
                    setAutoTermsNote(null);
                    const next = {
                      ...value,
                      parCallDate: clampDateYear(e.target.value),
                    };
                    onChange(next);
                    // par call일은 make-whole PV 지평(잔존만기)이므로 makeWhole
                    // 시나리오 중이면 기준금리를 재보간한다(감사 F8).
                    if (next.callScenario === "makeWhole") {
                      void applyMakeWholeRate(next, true);
                    }
                  }}
                  onKeyDown={commitOnEnter}
                />
              </Row>
              <Row label="Make-Whole 스프레드(bp)" editable>
                <input
                  className={inputClass}
                  type="text"
                  inputMode="decimal"
                  placeholder="예: 15"
                  value={value.makeWholeSpreadBps}
                  onFocus={selectAllOnFocus}
                  onChange={(e) => {
                    if (PERCENT_INPUT_PATTERN.test(e.target.value)) {
                      setAutoTermsNote(null);
                      update("makeWholeSpreadBps", e.target.value);
                    }
                  }}
                  onKeyDown={commitOnEnter}
                />
              </Row>
            </>
          )}

          {value.hasCall && (
            <>
              <Row label="시나리오" editable tall>
                {/* 세 옵션을 세로로 쌓되 줄높이를 줄여(leading-tight 17.5px×3
                    = 52.5px) 두 행 높이 76px(내용 58px) 안에 들어가게 한다 —
                    기본 줄높이 20px+gap이면 86px가 되어 옆 카드와 어긋났다. */}
                <div className="flex flex-col leading-tight">
                  {CALL_SCENARIO_LABELS.map((opt) => (
                    <label
                      key={opt.value}
                      className="flex items-center gap-1.5 text-sm leading-tight text-zinc-900 dark:text-zinc-100"
                    >
                      <input
                        type="radio"
                        name="callScenario"
                        className="h-3.5 w-3.5 accent-orange-600"
                        checked={value.callScenario === opt.value}
                        onChange={() => {
                          const next = { ...value, callScenario: opt.value };
                          onChange(next);
                          if (opt.value === "makeWhole") {
                            void applyMakeWholeRate(next, false);
                          }
                        }}
                      />
                      <span>{opt.label}</span>
                    </label>
                  ))}
                </div>
              </Row>

              {/* 자동추출 "추정" 문구는 시나리오 행 바로 아래 공란(라벨/값 칸 없이
                  한 줄 전체)에 둔다(사용자 지시). 인쇄엔 안 나온다. */}
              {autoTermsNote && (
                <div
                  // 이 공란만은 카드 폭 안에서 줄바꿈해 전문을 보여준다(사용자
                  // 지시 "줄바꿈"). 다른 행의 줄바꿈 금지 규칙과는 별개.
                  className={`${blankCellClass} min-w-0 items-start whitespace-normal break-words print:hidden`}
                >
                  <span className="text-xs text-amber-700 dark:text-amber-400">
                    <span className="mr-1 rounded border border-amber-400 px-1 text-[10px] font-semibold">
                      추정
                    </span>
                    {autoTermsNote}
                  </span>
                </div>
              )}

              {value.callScenario === "makeWhole" && (
                <>
                  <Row label="Make-Whole 상환일" editable>
                    <input
                      className={inputClass}
                      type="date"
                      value={value.makeWholeRedemptionDate}
                      onChange={(e) => {
                        const next = {
                          ...value,
                          makeWholeRedemptionDate: clampDateYear(e.target.value),
                        };
                        onChange(next);
                        // 상환일이 바뀌면 잔존만기가 달라지므로 항상 재보간(감사 F8).
                        void applyMakeWholeRate(next, true);
                      }}
                      onKeyDown={commitOnEnter}
                    />
                  </Row>
                  <Row label="기준 국채금리(%)" editable>
                    <div className="flex w-full items-center gap-2">
                      <input
                        className={inputClass}
                        type="text"
                        inputMode="decimal"
                        placeholder="예: 4.250"
                        value={value.makeWholeRefYield}
                        onFocus={selectAllOnFocus}
                        onChange={(e) => {
                          if (/^\d*(\.\d{0,3})?$/.test(e.target.value)) {
                            update("makeWholeRefYield", e.target.value);
                          }
                        }}
                        onKeyDown={commitOnEnter}
                      />
                      <button
                        type="button"
                        onClick={() => void applyMakeWholeRate(value, true)}
                        className="shrink-0 rounded border border-zinc-300 px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-white dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900 print:hidden"
                      >
                        자동
                      </button>
                    </div>
                  </Row>
                  <Row label="Make-Whole 상환가">
                    {effectiveRedemption.makeWholePricePer100 != null ? (
                      <span className="text-sm text-zinc-900 dark:text-zinc-100">
                        {effectiveRedemption.makeWholePricePer100.toFixed(3)}
                        <span className="ml-1 text-xs text-zinc-400 dark:text-zinc-600">
                          참고용 추정
                        </span>
                      </span>
                    ) : (
                      <ComputedValue />
                    )}
                  </Row>
                  {treasuryStatus && (
                    <Row label="">
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        {treasuryStatus}
                      </span>
                    </Row>
                  )}
                </>
              )}

              {value.callScenario !== "hold" &&
                effectiveRedemption.applied === "hold" && (
                  <Row label="">
                    <span className="text-xs text-amber-600 dark:text-amber-500">
                      시나리오 입력(상환일·스프레드·기준금리 등)이 부족하거나
                      결제일 이전 날짜라 만기보유로 계산 중입니다.
                    </span>
                  </Row>
                )}
            </>
          )}
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
              value.tradeCurrency === "KRW" ? "경과이자" : "경과이자(100$)"
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
          <Row label="거래통화" editable>
            <select
              className={`${inputClass} print:hidden`}
              value={value.tradeCurrency}
              onChange={(e) => {
                const tradeCurrency = e.target.value as Currency;
                // 결제일수 기본값(T+1/T+2)과 휴장 캘린더가 통화 시장마다 다르므로
                // 수기 결제일수는 통화를 바꾸면 자동으로 되돌린다.
                if (tradeCurrency === value.custodyCurrency) {
                  onChange({
                    ...value,
                    tradeCurrency,
                    purchaseFxRate: "1",
                    maturityFxRate: "1",
                    trustInvestmentAmount:
                      tradeCurrency === "KRW" ? "100000000" : "1000000",
                    settlementDays: "",
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
                  settlementDays: "",
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
          <Row
            // "자동" 배지/복원 버튼은 값 칸이 아니라 라벨 옆에 둔다 — 값 칸에
            // 달력 입력과 나란히 두면 폭이 넘쳐 잘렸다(사용자 지적).
            label={
              <span className="flex items-center gap-2">
                신탁만기일
                {value.trustMaturityDate.trim() !== "" ? (
                  <button
                    type="button"
                    onClick={() => update("trustMaturityDate", "")}
                    title="수기값을 지우고 자동계산(상환일 + 리드타임)으로 되돌립니다"
                    className="shrink-0 rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] font-normal text-zinc-500 hover:bg-white dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900 print:hidden"
                  >
                    자동
                  </button>
                ) : (
                  <span
                    title="자동계산: 상환일 + 리드타임(기본 11일)"
                    className="shrink-0 text-[11px] font-normal italic text-zinc-400 dark:text-zinc-600 print:hidden"
                  >
                    자동
                  </span>
                )}
              </span>
            }
            editable
          >
            {(() => {
              // 신탁만기일 = 실효 상환일(만기 또는 콜일) + 리드타임. 리드타임은
              // 기본 11일이고, 수기 override가 있으면 (override − 자산만기)
              // 차이일이 되어 콜 상환일에도 그대로 적용된다.
              const redemptionDate =
                effectiveRedemption.redemptionDate || value.maturityDate;
              const displayed =
                getTrustMaturityDate(
                  redemptionDate,
                  value.trustMaturityDate,
                  value.maturityDate
                ) ?? "";
              const isOverridden = value.trustMaturityDate.trim() !== "";
              const isEarlyRedemption =
                effectiveRedemption.applied !== "hold" && isOverridden;
              const leadDays = getTrustMaturityLeadDays(
                value.maturityDate,
                value.trustMaturityDate
              );
              if (!isOverridden && displayed === "") return <ComputedValue />;
              return (
                <input
                  className={inputClass}
                  type="date"
                  value={displayed}
                  title={
                    isEarlyRedemption
                      ? `수기 신탁만기일과 자산만기의 차이 ${leadDays}일을 상환일에 적용한 값`
                      : undefined
                  }
                  onChange={(e) => {
                    const typed = clampDateYear(e.target.value);
                    // 콜 시나리오 중에 고치면 "상환일 대비 차이일"을 자산만기
                    // 기준으로 환산해 저장한다 — 저장값은 항상 만기 기준 신탁만기일.
                    if (
                      effectiveRedemption.applied !== "hold" &&
                      /^\d{4}-\d{2}-\d{2}$/.test(typed)
                    ) {
                      const gapDays = Math.round(
                        (new Date(typed).getTime() -
                          new Date(redemptionDate).getTime()) /
                          86400000
                      );
                      const asset = new Date(value.maturityDate);
                      if (!Number.isNaN(asset.getTime())) {
                        asset.setUTCDate(asset.getUTCDate() + gapDays);
                        update(
                          "trustMaturityDate",
                          asset.toISOString().slice(0, 10)
                        );
                        return;
                      }
                    }
                    update("trustMaturityDate", typed);
                  }}
                  onKeyDown={commitOnEnter}
                />
              );
            })()}
          </Row>
          <Row label="투자일수">
            {(() => {
              const days = getInvestmentDays(
                value.trustContractDate,
                effectiveRedemption.redemptionDate || value.maturityDate,
                value.trustMaturityDate,
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
          <Row label="지급이자총액">
            {maturitySummary ? (
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                {formatSettlementAmount(
                  maturitySummary.totalInterestPaid,
                  value.custodyCurrency === "KRW"
                )}
              </span>
            ) : (
              <ComputedValue />
            )}
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
