"use client";

import { useEffect, useMemo, useState } from "react";
import { UserButton } from "@clerk/nextjs";
import { useAppAuth } from "@/components/auth/AppAuth";
import { SignupDialog } from "@/components/auth/SignupDialog";
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
    settlementDays: input.settlementDays,
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
    settlementDays: "",
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

/** 새로고침해도 직전 입력이 남도록 브라우저 탭(sessionStorage)에 보관하는 키. */
const INPUT_KEY = "bond.input.v1";

export default function Home() {
  const auth = useAppAuth();
  const [signupOpen, setSignupOpen] = useState(false);
  // /?signup=1 (로그인 팝업의 "가입" 링크)로 들어오면 가입 신청 팝업을 연다.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("signup") === "1") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSignupOpen(true);
    }
  }, []);
  const [input, setInput] = useState<BondLayoutInput>(createInitialInput);
  const [locked, setLocked] = useState<boolean>(createInitialLocked);
  // 공유 링크로 열린 세션인지 여부(최초 1회 계산 후 고정). locked는 토글 가능하지만
  // 이 값은 바뀌지 않아, 공유 링크로 열었을 때는 잠금 버튼을 계속 비활성화해둔다.
  const [isSharedLink] = useState<boolean>(createInitialLocked);

  // 직전 입력 복원/저장. 공유 링크로 연 세션은 링크 내용이 우선이라 건드리지 않는다.
  // 복원은 마운트 뒤에 한다(서버 렌더 결과와 어긋나지 않게). 읽을 때는 항상 기본값
  // 위에 덮어써서, 옛 버전이 남긴 값에 새로 생긴 칸이 없어도 undefined 가 흐르지 않게 한다.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!isSharedLink) {
      try {
        const raw = sessionStorage.getItem(INPUT_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as Partial<BondLayoutInput>;
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setInput({ ...createDefaultInput(), ...saved });
        }
      } catch {
        // 저장 차단·손상된 값 — 기본값으로 시작
      }
    }
    setRestored(true);
  }, [isSharedLink]);
  useEffect(() => {
    if (isSharedLink || !restored) return;
    try {
      sessionStorage.setItem(INPUT_KEY, JSON.stringify(input));
    } catch {
      // 저장 실패는 무시 — 기억만 안 될 뿐 화면은 그대로 동작
    }
  }, [input, isSharedLink, restored]);

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
        settlementDays: input.settlementDays,
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
      input.settlementDays,
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
              글로벌 채권정보
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              채권정보만 입력하면 현금흐름을 보여주는 서비스
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* 프로젝트 5(글로벌 리서치)의 거시경제 화면. 새 탭으로 연다. */}
            <a
              href="https://macro-insights.duckdns.org/macro"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              🌐 거시경제
            </a>
            {/* 출력은 승인 계정으로 로그인했을 때만(오너 지시) */}
            {auth.allowed === true && (
              <button
                type="button"
                onClick={() => window.print()}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                출력
              </button>
            )}
            {auth.enabled && auth.isSignedIn && (
              <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="hidden sm:inline">{auth.email}</span>
                {/* 아바타 클릭 → 계정 관리·로그아웃. 관리자에겐 「승인 관리」 추가 */}
                <UserButton>
                  {auth.isAdmin && (
                    <UserButton.MenuItems>
                      <UserButton.Link
                        label="승인 관리"
                        href="/admin"
                        labelIcon={
                          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                            <path d="M2 8.5l3.5 3.5L14 3.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        }
                      />
                    </UserButton.MenuItems>
                  )}
                </UserButton>
              </div>
            )}
            {auth.enabled && auth.isLoaded && !auth.isSignedIn && (
              <div className="flex items-center gap-3 text-sm">
                <button
                  type="button"
                  onClick={auth.openSignIn}
                  className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  로그인
                </button>
                <span className="text-zinc-300 dark:text-zinc-700">|</span>
                <button
                  type="button"
                  onClick={() => setSignupOpen(true)}
                  className="text-zinc-600 hover:underline dark:text-zinc-400"
                >
                  가입 신청
                </button>
              </div>
            )}
          </div>
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
      <SignupDialog
        open={signupOpen}
        onClose={() => setSignupOpen(false)}
        allowedDomains={auth.allowedDomains}
      />
    </div>
  );
}
