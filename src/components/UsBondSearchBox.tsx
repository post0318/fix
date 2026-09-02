"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BondLayoutInput,
  CalcBasis,
  CouponFrequency,
  Currency,
  TaxStatus,
} from "@/types/bondLayout";

interface CompanyInfo {
  cik: string;
  ticker: string;
  name: string;
}

const TREASURY_COMPANY: CompanyInfo = {
  cik: "TREASURY",
  ticker: "UST",
  name: "U.S. Treasury",
};

/** FINRA Fixed Income Data — CUSIP/TRACE symbol로 채권을 검색해 신용등급 등 상세정보를 확인할 수 있다 */
const FINRA_FIXED_INCOME_URL = "https://www.finra.org/finra-data/fixed-income";

interface SecListItem {
  kind: "sec";
  label: string;
  isin: string | null;
  maturityDate: string | null;
  couponRate: number | null;
  indexUrl: string;
  filedDate: string;
}

interface TreasuryBondItem {
  cusip: string;
  securityType: string;
  term: string;
  issueDate: string;
  maturityDate: string;
  couponRate: number;
  frequency: string;
}

interface TreasuryListItem {
  kind: "treasury";
  label: string;
  isin: string | null;
  maturityDate: string | null;
  couponRate: number | null;
  data: TreasuryBondItem;
}

type ListItem = SecListItem | TreasuryListItem;

interface BondTranche {
  label: string;
  maturityDate: string | null;
  couponRate: number | null;
  isin: string | null;
  rating: string | null;
  couponFrequencyMonths: number | null;
  settlementDate: string | null;
  calcBasis: string | null;
}

interface FwpDetail {
  tranches: BondTranche[];
  currency: string;
  issuer: string | null;
}

const CURRENCY_VALUES: Currency[] = ["USD", "EUR", "CNY", "JPY", "KRW"];
const CALC_BASIS_VALUES: CalcBasis[] = [
  "미국 30/360",
  "ACT/ACT",
  "ACT/360",
  "ACT/365",
  "유럽 30/360",
];

function frequencyFromMonths(months: number | null): CouponFrequency | null {
  if (months === 3) return "3개월";
  if (months === 6) return "6개월";
  if (months === 12) return "12개월";
  return null;
}

function frequencyFromTreasuryLabel(label: string): number | null {
  if (/semi-annual/i.test(label)) return 6;
  if (/quarterly/i.test(label)) return 3;
  if (/annual/i.test(label)) return 12;
  return null;
}

/** "2031-05-15" -> "05/15/2031" (미국식 표기, 목록에서 만기연월을 짧게 보여주기 위함) */
function formatUsDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}

/**
 * 9자리 CUSIP -> 12자리 ISIN(ISO 6166) 변환. "US" + CUSIP + 체크숫자(Luhn).
 * 미국국채는 CUSIP만 갖고 있는데, boerse-frankfurt는 ISIN으로 조회해야 해서
 * (실제 검증: US912810US5 -> ISIN US912810US59로 정확히 상장돼 있음 확인)
 * 매수금리 추정에 필요한 변환이다.
 */
function isinFromCusip(cusip: string): string {
  const base = `US${cusip}`;
  let digits = "";
  for (const ch of base) {
    digits += /[0-9]/.test(ch) ? ch : (ch.charCodeAt(0) - 55).toString();
  }
  let sum = 0;
  let alt = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return `${base}${checkDigit}`;
}

/** "US"+CUSIP(9자리)+체크숫자 형태의 미국 ISIN에서 CUSIP만 뽑아낸다.
 * FINRA 채권 검색은 ISIN이 아니라 CUSIP으로 찾는다. */
function cusipFromIsin(isin: string): string {
  return /^US[0-9A-Z]{10}$/.test(isin) ? isin.slice(2, 11) : isin;
}

interface UsBondSearchBoxProps {
  disabled: boolean;
  active: boolean;
  // disclosureRating: 신용등급이 SEC 공시서류(FWP) 기준 값인지 여부.
  // 국채(RF/실시간 국가등급)나 값을 못 찾은 경우는 false.
  onApply: (
    fields: Partial<BondLayoutInput>,
    meta?: { disclosureRating?: boolean }
  ) => void;
}

/**
 * SEC EDGAR(공식·자동화 허용)의 FWP(가격결정 조건표) 문서와 fiscaldata.treasury.gov
 * (공식·무료·키 불필요) 경매 데이터를 서버에서 조회해 미국 회사채/국채의 발행일/
 * 만기일/표면이율/지급주기/날짜계산기준/신용등급/거래통화를 자동 반영한다.
 * 종목검색(boerse-frankfurt)과 동일하게 회사(또는 국채) 선택 즉시 최근 채권을
 * 평면 목록으로 보여주고 텍스트로 좁힐 수 있다. 발행사·주간사마다 문서 서식이
 * 달라 회사채는 100% 정확하지 않을 수 있다. 한국채권검색의 SEIBRO 링크와
 * 동일하게, 종목 선택 시 FINRA Fixed Income Data 페이지로 이동하는 신용등급
 * 확인용 참조 링크를 함께 보여준다(단, 미국국채는 아래처럼 신용등급이 이미
 * 확정 반영되므로 링크를 보여주지 않는다). 미국국채는 개별 신용평가 대상이
 * 아니라 tradingeconomics.com/country-list/rating에서 가져온 미국 국가신용
 * 등급(S&P/Moody's만, DBRS 제외)을 신용등급으로 자동 반영한다(한국채권검색의
 * 국고채권과 동일한 취급, 조회 지연에 대비해 우선 "RF"를 반영해두고 성공 시
 * 실제 등급으로 갱신).
 */
export function UsBondSearchBox({ disabled, active, onApply }: UsBondSearchBoxProps) {
  const [open, setOpen] = useState(false);
  const [companies, setCompanies] = useState<CompanyInfo[] | null>(null);
  const [companiesError, setCompaniesError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedCompany, setSelectedCompany] = useState<CompanyInfo | null>(null);
  const [bonds, setBonds] = useState<ListItem[] | null>(null);
  const [loadingBonds, setLoadingBonds] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [ratingLink, setRatingLink] = useState<string | null>(null);
  const [ratingCusip, setRatingCusip] = useState<string | null>(null);
  const [cusipCopied, setCusipCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || companies !== null || companiesError) return;
    let cancelled = false;
    fetch("/api/us-companies")
      .then((res) => {
        if (!res.ok) throw new Error("failed");
        return res.json();
      })
      .then((data: { companies?: CompanyInfo[] }) => {
        if (!cancelled) setCompanies(Array.isArray(data.companies) ? data.companies : []);
      })
      .catch(() => {
        if (!cancelled) setCompaniesError("온라인(Vercel) 배포판에서만 미국채권검색을 사용할 수 있습니다.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, companies, companiesError]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const matchingCompanies = useMemo(() => {
    if (!companies || selectedCompany) return [];
    const keyword = query.trim().toLowerCase();
    if (!keyword) return [];
    return companies
      .filter((c) => c.name.toLowerCase().includes(keyword) || c.ticker.toLowerCase() === keyword)
      .slice(0, 15);
  }, [companies, query, selectedCompany]);

  const filteredBonds = useMemo(() => {
    if (!bonds) return [];
    const keyword = query.trim().toLowerCase();
    if (!keyword) return bonds;
    return bonds.filter((b) => {
      // 국채(kind: "treasury")는 isin 자리에 9자리 CUSIP만 들어있는데,
      // boerse-frankfurt 등 해외에서는 12자리 ISIN(US+CUSIP+체크숫자)으로
      // 표기돼 그 값을 그대로 붙여넣으면 검색이 안 됐다(실제 확인:
      // "US912810TM09"로 검색해도 안 잡힘). 계산한 ISIN도 함께 매칭한다.
      const treasuryIsin = b.kind === "treasury" && b.isin ? isinFromCusip(b.isin) : "";
      return `${b.label} ${b.couponRate ?? ""} ${b.maturityDate ?? ""} ${b.isin ?? ""} ${treasuryIsin}`
        .toLowerCase()
        .includes(keyword);
    });
  }, [bonds, query]);

  const selectCompany = (company: CompanyInfo) => {
    setSelectedCompany(company);
    setQuery("");
    setBonds(null);
    setStatus(null);
    setLoadingBonds(true);
    const today = new Date().toISOString().slice(0, 10);

    if (company.cik === TREASURY_COMPANY.cik) {
      fetch("/api/us-treasury-list")
        .then((res) => res.json())
        .then((data: { bonds?: TreasuryBondItem[] }) => {
          const all = Array.isArray(data.bonds) ? data.bonds : [];
          const items: TreasuryListItem[] = all
            .filter((b) => b.maturityDate >= today)
            .map((b) => ({
              kind: "treasury",
              label: `${b.term} ${b.couponRate}% ${b.maturityDate.slice(0, 4)}`,
              isin: b.cusip,
              maturityDate: b.maturityDate,
              couponRate: b.couponRate,
              data: b,
            }));
          setBonds(items);
        })
        .catch(() => setStatus("국채 목록을 불러오지 못했습니다."))
        .finally(() => setLoadingBonds(false));
      return;
    }

    fetch(`/api/us-bond-list?cik=${company.cik}`)
      .then((res) => res.json())
      .then((data: { bonds?: Omit<SecListItem, "kind">[] }) => {
        const all = Array.isArray(data.bonds) ? data.bonds : [];
        const items: SecListItem[] = all
          .filter((b) => !b.maturityDate || b.maturityDate >= today)
          .map((b) => ({ kind: "sec", ...b }));
        setBonds(items);
      })
      .catch(() => setStatus("채권 목록을 불러오지 못했습니다."))
      .finally(() => setLoadingBonds(false));
  };

  const selectBond = (bond: ListItem) => {
    if (bond.kind === "treasury") {
      const tranche: BondTranche = {
        label: bond.label,
        maturityDate: bond.data.maturityDate,
        couponRate: bond.data.couponRate,
        isin: bond.data.cusip,
        rating: "RF",
        couponFrequencyMonths: frequencyFromTreasuryLabel(bond.data.frequency),
        settlementDate: bond.data.issueDate,
        calcBasis: "ACT/ACT",
      };
      applyTranche(tranche, TREASURY_COMPANY.name, "USD", true);
      fetch("/api/country-rating?slug=united-states")
        .then((res) => res.json())
        .then((data: { rating?: string | null }) => {
          if (data.rating) onApply({ creditRating: data.rating });
        })
        .catch(() => {});
      return;
    }

    setStatus("조회 중...");
    const params = new URLSearchParams({
      cik: selectedCompany?.cik ?? "",
      indexUrl: bond.indexUrl,
      filedDate: bond.filedDate,
    });
    fetch(`/api/us-bond-detail?${params}`)
      .then((res) => res.json())
      .then((data: FwpDetail) => {
        const tranche =
          data.tranches?.find((t) => t.isin === bond.isin) ?? data.tranches?.[0] ?? null;
        if (!tranche) {
          setStatus("상세정보를 찾지 못했습니다.");
          return;
        }
        applyTranche(tranche, data.issuer, data.currency);
      })
      .catch(() => setStatus("상세정보를 불러오지 못했습니다."));
  };

  const applyTranche = (
    tranche: BondTranche,
    issuer: string | null,
    currency: string,
    isTreasury = false
  ) => {
    const fields: Partial<BondLayoutInput> = {};
    const displayIssuer = issuer ?? selectedCompany?.name ?? "";
    if (displayIssuer && tranche.couponRate !== null && tranche.maturityDate) {
      const year = tranche.maturityDate.slice(0, 4);
      fields.name = `${displayIssuer} ${tranche.couponRate}% ${year}`;
    }
    if (tranche.settlementDate) fields.issueDate = tranche.settlementDate;
    if (tranche.maturityDate) fields.maturityDate = tranche.maturityDate;
    if (tranche.couponRate !== null) fields.couponRate = String(tranche.couponRate);
    fields.creditRating = tranche.rating ?? "";
    // 비과세 기본값은 브라질 국채만 대상이므로, 미국채권검색에서는 이전 선택
    // 값이 남지 않도록 일반과세로 되돌린다.
    fields.taxStatus = "일반과세" as TaxStatus;
    // 이 데이터소스(SEC EDGAR FWP/fiscaldata.treasury.gov) 자체에는 매수금리
    // (현재 시장 수익률) 정보가 없다. 일단 0으로 비워(다른 검색에서 반영된
    // 값이 남지 않도록) 아래에서 boerse-frankfurt 현재가 기반 추정치로
    // 갱신한다.
    fields.purchaseYield = "0";
    if (tranche.calcBasis && CALC_BASIS_VALUES.includes(tranche.calcBasis as CalcBasis)) {
      fields.calcBasis = tranche.calcBasis as CalcBasis;
    }
    const frequency = frequencyFromMonths(tranche.couponFrequencyMonths);
    if (frequency) fields.couponFrequency = frequency;
    if (CURRENCY_VALUES.includes(currency as Currency)) {
      fields.tradeCurrency = currency as Currency;
    }

    onApply(fields, { disclosureRating: !isTreasury && !!tranche.rating });
    setRatingLink(isTreasury ? null : FINRA_FIXED_INCOME_URL);
    setRatingCusip(!isTreasury && tranche.isin ? cusipFromIsin(tranche.isin) : null);
    setCusipCopied(false);

    const missing: string[] = [];
    if (!tranche.rating) missing.push("신용등급");
    if (!frequency) missing.push("지급주기");
    if (!tranche.calcBasis) missing.push("날짜계산기준");
    const baseStatus =
      missing.length > 0
        ? `일부 항목을 반영했습니다. ${missing.join("/")}은(는) 자동으로 찾지 못해 직접 입력이 필요합니다.`
        : "OK";
    setStatus(baseStatus);
    // 매수금리를 못 찾은 경우, 0%가 실제 조회값처럼 보이지 않도록 별도로
    // 안내한다(boerse-frankfurt 조회 실패/데이터 없음 모두 포함).
    const notifyYieldMissing = () =>
      setStatus(
        baseStatus === "OK"
          ? "관련종목의 매수금리가 확인되지 않습니다. 직접 확인이 필요합니다."
          : `${baseStatus} 관련종목의 매수금리가 확인되지 않습니다. 직접 확인이 필요합니다.`
      );

    // 매수금리: boerse-frankfurt 현재가 기반 추정치(종목검색과 동일한
    // 로직)로 갱신한다. 회사채(tranche.isin)는 이미 진짜 ISIN이고, 국채는
    // CUSIP만 있어 표준 규칙으로 ISIN을 계산해 넘긴다.
    if (tranche.isin && tranche.couponRate !== null && tranche.maturityDate) {
      const isin = isTreasury ? isinFromCusip(tranche.isin) : tranche.isin;
      const params = new URLSearchParams({
        isin,
        couponRate: String(tranche.couponRate),
        maturityDate: tranche.maturityDate,
      });
      if (tranche.couponFrequencyMonths != null)
        params.set("freqMonths", String(tranche.couponFrequencyMonths));
      fetch(`/api/us-bond-yield?${params}`)
        .then((res) => res.json())
        .then((data: { rate?: number | null }) => {
          if (typeof data.rate === "number") {
            onApply({ purchaseYield: String(data.rate) });
            setStatus(
              baseStatus === "OK"
                ? "매수금리는 현재가 기준 추정치입니다 — 체결 전 확인 바랍니다."
                : `${baseStatus} 매수금리는 현재가 기준 추정치입니다.`
            );
          } else {
            notifyYieldMissing();
          }
        })
        .catch(() => notifyYieldMissing());
    } else {
      notifyYieldMissing();
    }
    setOpen(false);
  };

  const resetCompany = () => {
    setSelectedCompany(null);
    setBonds(null);
    setQuery("");
  };

  return (
    <div className="relative inline-flex items-center gap-2" ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="text-sm font-medium text-blue-600 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-zinc-400 dark:text-blue-400 dark:disabled:text-zinc-600"
      >
        미국채권검색
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-96 rounded-lg border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {companiesError ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{companiesError}</p>
          ) : (
            <>
              {selectedCompany && (
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-zinc-600 dark:text-zinc-300">
                    {selectedCompany.name}
                    {selectedCompany.cik !== TREASURY_COMPANY.cik && ` (${selectedCompany.ticker})`}
                  </span>
                  <button
                    type="button"
                    onClick={resetCompany}
                    className="shrink-0 text-xs text-zinc-400 hover:underline"
                  >
                    ← 다른 회사
                  </button>
                </div>
              )}

              {!selectedCompany && (
                <>
                  <button
                    type="button"
                    onClick={() => selectCompany(TREASURY_COMPANY)}
                    className="mb-2 block w-full rounded-md border border-zinc-300 px-2 py-1.5 text-left text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    {TREASURY_COMPANY.name}
                  </button>
                  <input
                    autoFocus
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="회사명/티커 입력 (예: Apple)"
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-blue-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                  />
                  <ul className="mt-2 max-h-56 overflow-y-auto">
                    {matchingCompanies.map((c) => (
                      <li key={c.cik}>
                        <button
                          type="button"
                          onClick={() => selectCompany(c)}
                          className="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                          {c.name} <span className="text-xs text-zinc-400">{c.ticker}</span>
                        </button>
                      </li>
                    ))}
                    {query.trim() && matchingCompanies.length === 0 && (
                      <li className="px-2 py-1 text-xs text-zinc-400">일치하는 회사가 없습니다.</li>
                    )}
                  </ul>
                </>
              )}

              {selectedCompany && (
                <>
                  {loadingBonds && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">채권 목록 불러오는 중...</p>
                  )}
                  {!loadingBonds && bonds && (
                    <>
                      <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="채권명/쿠폰/만기로 좁히기 (예: 2032 또는 4.5)"
                        className="mb-2 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-blue-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      />
                      <ul className="max-h-56 overflow-y-auto">
                        {filteredBonds.map((b, i) => (
                          <li key={`${b.isin ?? i}`}>
                            <button
                              type="button"
                              onClick={() => selectBond(b)}
                              className="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                            >
                              {/* 회사채(kind: "sec")는 label이 "2031 Notes"처럼
                                  공시서류 원문 트랜치명이라 연도만 있고 월이
                                  없어, 같은 해에 만기가 다른 트랜치를 구분할
                                  수 없었다(실제 확인). label 대신 만기일
                                  (미국식 MM/DD/YYYY)로 바로 보여준다. 국채
                                  (kind: "treasury")는 label 자체에 이미
                                  쿠폰까지 포함돼("29-Year 6-Month 2.375%
                                  2056") 있어 그대로 쓴다. */}
                              {b.kind === "sec"
                                ? b.maturityDate
                                  ? formatUsDate(b.maturityDate)
                                  : (b.label || "만기 -")
                                : b.label || `만기 ${b.maturityDate ?? "-"}`}
                              {b.kind === "sec" && b.couponRate !== null
                                ? ` · ${b.couponRate}%`
                                : ""}
                              <span className="ml-1 text-xs text-zinc-400">{b.isin}</span>
                            </button>
                          </li>
                        ))}
                        {bonds.length === 0 && (
                          <li className="px-2 py-1 text-xs text-zinc-400">
                            만기가 지나지 않은 최근 발행 채권이 없습니다.
                          </li>
                        )}
                        {bonds.length > 0 && filteredBonds.length === 0 && (
                          <li className="px-2 py-1 text-xs text-zinc-400">일치하는 종목이 없습니다.</li>
                        )}
                      </ul>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {active && (status || ratingLink) && !open && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {status}
          {ratingLink && (
            <>
              {" "}
              <a
                href={ratingLink}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  if (ratingCusip && navigator.clipboard) {
                    navigator.clipboard
                      .writeText(ratingCusip)
                      .then(() => setCusipCopied(true))
                      .catch(() => {});
                  }
                }}
                className="text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
              >
                FINRA에서 신용등급 확인
                {ratingCusip
                  ? ` (CUSIP ${ratingCusip}${cusipCopied ? " 복사됨" : " 클릭시 복사"})`
                  : ""}
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
