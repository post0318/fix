"use client";

import { useMemo, useState } from "react";
import { BondLayoutForm } from "@/components/BondLayoutForm";
import { CashFlowTable } from "@/components/CashFlowTable";
import { generateFixCashFlow } from "@/lib/cashFlowSchedule";
import { getEffectiveRedemption } from "@/lib/bondPricing";
import { decodeBondLink } from "@/lib/bondLink";
import { BondLayoutInput } from "@/types/bondLayout";

/** 현금흐름표 위에 붙일 시나리오 캡션. hold이면 null. */
function scenarioNote(input: BondLayoutInput): string | null {
  const eff = getEffectiveRedemption({
    hasCall: input.hasCall,
    callScenario: input.callScenario,
    maturityDate: input.maturityDate,
    parCallDate: input.parCallDate,
    makeWholeRedemptionDate: input.makeWholeRedemptionDate,
    makeWholeRefYield: input.makeWholeRefYield,
    makeWholeSpreadBps: input.makeWholeSpreadBps,
    couponRate: input.couponRate,
    couponFrequency: input.couponFrequency,
    calcBasis: input.calcBasis,
    tradeCurrency: input.tradeCurrency,
    trustContractDate: input.trustContractDate,
    hasPut: input.hasPut,
    putDate: input.putDate,
  });
  if (eff.applied === "parCall") {
    return `시나리오: Par Call 행사 · ${eff.redemptionDate} 액면상환`;
  }
  if (eff.applied === "makeWhole") {
    const px = eff.makeWholePricePer100;
    return `시나리오: Make-Whole 상환 · ${eff.redemptionDate}${
      px != null ? ` · 상환가 ${px.toFixed(3)} (참고용 추정)` : ""
    }`;
  }
  if (eff.applied === "put") {
    return `시나리오: 풋옵션 행사 · ${eff.redemptionDate} 액면상환`;
  }
  return null;
}

function todayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function createDefaultInput(): BondLayoutInput {
  return {
    calcBasis: "미국 30/360",
    investorType: "개인",
    name: "",
    issueDate: "",
    maturityDate: "",
    couponRate: "",
    couponFrequency: "6개월",
    recentCouponDate: "",
    taxStatus: "일반과세",
    creditRating: "",
    tradeCurrency: "USD",
    custodyCurrency: "USD",
    purchaseFxRate: "1",
    maturityFxRate: "1",
    trustContractDate: todayDateString(),
    trustMaturityDate: "",
    purchaseYield: "0.00",
    trustInvestmentAmount: "1000000",
    frontFeeRate: "0.00",
    backFeeRate: "0.00",
    incomeTaxRate: "15.40",
    hasCall: false,
    parCallDate: "",
    makeWholeSpreadBps: "",
    callScenario: "hold",
    makeWholeRedemptionDate: "",
    makeWholeRefYield: "",
    isin: "",
    hasPut: false,
    putDate: "",
  };
}

function createInitialInput(): BondLayoutInput {
  if (typeof window === "undefined") return createDefaultInput();
  const decoded = decodeBondLink(window.location.search);
  return decoded ? { ...createDefaultInput(), ...decoded } : createDefaultInput();
}

function createInitialLocked(): boolean {
  if (typeof window === "undefined") return false;
  return decodeBondLink(window.location.search) !== null;
}

export default function Home() {
  const [input, setInput] = useState<BondLayoutInput>(createInitialInput);
  const [locked, setLocked] = useState<boolean>(createInitialLocked);
  // 공유 링크로 열린 세션인지 여부(최초 1회 계산 후 고정). locked는 토글 가능하지만
  // 이 값은 바뀌지 않아, 공유 링크로 열었을 때는 잠금 버튼을 계속 비활성화해둔다.
  const [isSharedLink] = useState<boolean>(createInitialLocked);

  const cashFlowRows = useMemo(
    () =>
      generateFixCashFlow({
        maturityDate: input.maturityDate,
        couponRate: input.couponRate,
        couponFrequency: input.couponFrequency,
        purchaseYield: input.purchaseYield,
        calcBasis: input.calcBasis,
        trustContractDate: input.trustContractDate,
        recentCouponDate: input.recentCouponDate,
        tradeCurrency: input.tradeCurrency,
        custodyCurrency: input.custodyCurrency,
        purchaseFxRate: input.purchaseFxRate,
        maturityFxRate: input.maturityFxRate,
        trustInvestmentAmount: input.trustInvestmentAmount,
        frontFeeRate: input.frontFeeRate,
        backFeeRate: input.backFeeRate,
        investorType: input.investorType,
        taxStatus: input.taxStatus,
        hasCall: input.hasCall,
        callScenario: input.callScenario,
        parCallDate: input.parCallDate,
        makeWholeRedemptionDate: input.makeWholeRedemptionDate,
        makeWholeRefYield: input.makeWholeRefYield,
        makeWholeSpreadBps: input.makeWholeSpreadBps,
        hasPut: input.hasPut,
        putDate: input.putDate,
      }),
    [
      input.maturityDate,
      input.couponRate,
      input.couponFrequency,
      input.purchaseYield,
      input.calcBasis,
      input.trustContractDate,
      input.recentCouponDate,
      input.tradeCurrency,
      input.custodyCurrency,
      input.purchaseFxRate,
      input.maturityFxRate,
      input.trustInvestmentAmount,
      input.frontFeeRate,
      input.backFeeRate,
      input.investorType,
      input.taxStatus,
      input.hasCall,
      input.callScenario,
      input.parCallDate,
      input.makeWholeRedemptionDate,
      input.makeWholeRefYield,
      input.makeWholeSpreadBps,
      input.hasPut,
      input.putDate,
    ]
  );

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14 print:p-0">
        <div className="mb-4 print:mb-1 flex items-center justify-between gap-4">
          <p className="text-sm font-bold text-red-600 dark:text-red-500">
            ※ 본 자료는 참고용 자료로만 활용될 수 있으며, 불특정 다수에게
            제공이 금지된 사내한 자료입니다.
          </p>
          <span className="shrink-0 rounded-md border border-red-600 px-2 py-0.5 text-sm font-bold text-red-600 dark:border-red-500 dark:text-red-500">
            사내한
          </span>
        </div>
        <p className="hidden print:mb-1 print:block text-sm">&nbsp;</p>
        <header className="mb-8 flex items-start justify-between gap-4 print:hidden">
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
              채권세상
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              채권정보만 입력하면 현금흐름을 보여주는 서비스
            </p>
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            className="shrink-0 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            출력
          </button>
        </header>

        <div className="flex flex-col gap-6 print:gap-2">
          <BondLayoutForm
            value={input}
            onChange={setInput}
            locked={locked}
            onLockedChange={setLocked}
            lockToggleDisabled={isSharedLink}
          />
          <CashFlowTable
            rows={cashFlowRows}
            custodyCurrency={input.custodyCurrency}
            scenarioNote={scenarioNote(input)}
          />
        </div>
      </main>
    </div>
  );
}
