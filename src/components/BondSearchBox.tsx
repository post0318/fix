"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BondLayoutInput, CalcBasis, CouponFrequency, Currency, TaxStatus } from "@/types/bondLayout";
import { COUNTRY_ISSUER_ALIASES, COUNTRY_ISSUER_SLUGS } from "@/lib/countryIssuerAliases";

interface BondSearchItem {
  isin: string;
  name: string;
  coupon: number | null;
  currency: string | null;
  slug: string | null;
}

interface BondDetail {
  isin: string;
  issueDate: string | null;
  maturityDate: string | null;
  couponRate: number | null;
  currency: string | null;
  slug: string | null;
  bidYield: number | null;
  askYield: number | null;
  lastPriceYield: number | null;
  couponFrequencyMonths: number | null;
}

const CURRENCY_VALUES: Currency[] = ["USD", "EUR", "CNY", "JPY", "KRW", "BRL"];

/**
 * boerse-frankfurt 검색 목록에는 만기일 필드가 없어(상세조회를 해야 알 수 있음),
 * 종목명 끝의 "발행연도/만기연도" 표기(예: "3,85% 22/32")에서 만기연도를 추정한다.
 * 패턴이 없으면 걸러내지 않고 그대로 남긴다(오탐으로 유효 종목을 숨기지 않기 위함).
 */
function approxMaturityYear(name: string): number | null {
  const m = name.match(/(\d{2})\/(\d{2})\s*$/);
  if (!m) return null;
  return 2000 + parseInt(m[2], 10);
}

function isNotMatured(name: string): boolean {
  const year = approxMaturityYear(name);
  if (year === null) return true;
  return year >= new Date().getFullYear();
}

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

interface BondSearchBoxProps {
  disabled: boolean;
  active: boolean;
  onApply: (fields: Partial<BondLayoutInput>) => void;
}

/**
 * boerse-frankfurt.de 비공식 API로 발행자→채권→상세정보(발행일/만기일/표면이율/거래통화)를
 * 조회해 편입자산정보에 반영한다. 지급주기/날짜계산기준은 이 API에 값이 없어
 * 상세페이지 링크로 안내하고 직접 입력하도록 한다. 발행자 목록은 회사명은
 * 대부분 영문이지만 국가(주권) 발행자명은 lang=en으로 바꿔도 독일어로만 내려와
 * (확인됨) 한국 사용자가 "Brazil"처럼 영어로 검색하면 매칭되지 않는다.
 * countryIssuerAliases.ts에 독일어 국가명↔영어 별칭을 하드코딩해두고 함께
 * 매칭한다. 발행자가 국가 자체(=국채)이면 같은 파일의 슬러그 매핑으로
 * tradingeconomics.com에서 국가신용등급을 가져와 자동 반영한다(한국채권검색의
 * 국고채권, 미국채권검색의 U.S. Treasury와 동일한 취급).
 */
export function BondSearchBox({ disabled, active, onApply }: BondSearchBoxProps) {
  const [open, setOpen] = useState(false);
  const [issuers, setIssuers] = useState<string[] | null>(null);
  const [issuersError, setIssuersError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedIssuer, setSelectedIssuer] = useState<string | null>(null);
  const [bonds, setBonds] = useState<BondSearchItem[] | null>(null);
  const [loadingBonds, setLoadingBonds] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [detailSlug, setDetailSlug] = useState<string | null>(null);
  const [quoteInfo, setQuoteInfo] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || issuers !== null || issuersError) return;
    let cancelled = false;
    fetch("/api/bond-issuers")
      .then((res) => {
        if (!res.ok) throw new Error("failed");
        return res.json();
      })
      .then((data: { issuers?: string[] }) => {
        if (!cancelled) setIssuers(Array.isArray(data.issuers) ? data.issuers : []);
      })
      .catch(() => {
        if (!cancelled) {
          setIssuersError("온라인(Vercel) 배포판에서만 종목검색을 사용할 수 있습니다.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, issuers, issuersError]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // "us" -> USA처럼 국가 별칭(COUNTRY_ISSUER_ALIASES)에 매칭되면, 회사명에
  // 우연히 같은 문자열이 들어간 항목(예: "USA"가 들어간 회사명은 아주 흔함)
  // 보다 항상 앞에 오도록 한다. 그렇지 않으면 상위 15개가 전부 우연한
  // 이름 일치로 채워져 정작 찾는 국가가 안 보이는 문제가 있었다(실제 확인:
  // "us" 검색 시 "United States of America"가 목록에 아예 안 보임).
  const matchingIssuers = useMemo(() => {
    if (!issuers || selectedIssuer) return [];
    const keyword = query.trim().toLowerCase();
    if (!keyword) return [];
    const aliasMatches: string[] = [];
    const nameMatches: string[] = [];
    for (const i of issuers) {
      const aliases = COUNTRY_ISSUER_ALIASES[i];
      if (aliases?.some((alias) => alias.includes(keyword))) {
        aliasMatches.push(i);
      } else if (i.toLowerCase().includes(keyword)) {
        nameMatches.push(i);
      }
    }
    return [...aliasMatches, ...nameMatches].slice(0, 15);
  }, [issuers, query, selectedIssuer]);

  const filteredBonds = useMemo(() => {
    if (!bonds) return [];
    const keyword = query.trim().toLowerCase();
    if (!keyword) return bonds;
    return bonds.filter((b) =>
      `${b.name} ${b.coupon ?? ""}`.toLowerCase().includes(keyword)
    );
  }, [bonds, query]);

  const selectIssuer = (issuer: string) => {
    setSelectedIssuer(issuer);
    setQuery("");
    setBonds(null);
    setStatus(null);
    setDetailSlug(null);
    setQuoteInfo(null);
    setLoadingBonds(true);
    fetch(`/api/bond-search?issuer=${encodeURIComponent(issuer)}`)
      .then((res) => res.json())
      .then((data: { bonds?: BondSearchItem[] }) => {
        const all = Array.isArray(data.bonds) ? data.bonds : [];
        // 쿠폰이 없는 종목(coupon: null)은 대부분 미국 단기국채(T-Bill) 같은
        // 무이표 할인채다. 이 앱의 현금흐름 계산은 이표 지급을 전제로 하고
        // 있어(미국채권검색도 같은 이유로 T-Bill을 아예 조회 대상에서
        // 제외함) 정확히 계산할 수 없으므로 목록에서도 걸러낸다.
        // 앱이 지원하는 통화(6종)가 아니면(예: CHF) 거래통화를 반영할 방법이
        // 없어 목록에서 제외한다(실제 확인: Alphabet의 CHF 채권
        // CH1504033718). 통화 정보 자체가 없는 항목(currency: null)은
        // 상세조회 전이라 모르는 것뿐이라 걸러내지 않는다.
        setBonds(
          all.filter(
            (b) =>
              isNotMatured(b.name) &&
              b.coupon !== null &&
              (!b.currency || CURRENCY_VALUES.includes(b.currency as Currency))
          )
        );
      })
      .catch(() => setStatus("채권 목록을 불러오지 못했습니다."))
      .finally(() => setLoadingBonds(false));
  };

  const selectBond = (bond: BondSearchItem) => {
    setStatus("조회 중...");
    fetch(`/api/bond-detail?isin=${encodeURIComponent(bond.isin)}`)
      .then((res) => res.json())
      .then((data: BondDetail) => {
        const fields: Partial<BondLayoutInput> = {};
        fields.name = bond.name;
        if (data.issueDate) fields.issueDate = data.issueDate;
        if (data.maturityDate) fields.maturityDate = data.maturityDate;
        if (typeof data.couponRate === "number") fields.couponRate = String(data.couponRate);
        if (data.currency && CURRENCY_VALUES.includes(data.currency as Currency)) {
          fields.tradeCurrency = data.currency as Currency;
        }
        // 매수수익률: 실제 매수 체결에 가까운 ask(매도호가) 기준 수익률을 우선,
        // 없으면 최종가 기준 수익률로 대체한다. 값이 없으면 다른 종목검색에서
        // 반영된 값이 남지 않도록 0으로 되돌린다.
        const applicableYield = data.askYield ?? data.lastPriceYield;
        fields.purchaseYield =
          typeof applicableYield === "number" ? String(applicableYield) : "0";
        const yieldParts: string[] = [];
        if (typeof data.askYield === "number") yieldParts.push(`매수(ask) ${data.askYield}%`);
        if (typeof data.bidYield === "number") yieldParts.push(`매도(bid) ${data.bidYield}%`);
        if (
          yieldParts.length === 0 &&
          typeof data.lastPriceYield === "number"
        ) {
          yieldParts.push(`최종가 ${data.lastPriceYield}% (추정)`);
        }
        setQuoteInfo(yieldParts.length > 0 ? yieldParts.join(" · ") : "수익률 정보 없음");
        // 이 API는 신용등급을 제공하지 않는다. 이전 종목 선택 때 값이 남아있지
        // 않도록 일단 비워두고, 국채(국가 발행자)면 아래에서 실제 등급으로 갱신한다.
        fields.creditRating = "";
        // 발행자가 국가(주권) 자체이면 국채이므로 발행국 국가신용등급을 자동 반영한다.
        const countrySlug = selectedIssuer ? COUNTRY_ISSUER_SLUGS[selectedIssuer] : undefined;
        // 브라질 국채는 과세여부 기본값을 비과세로 반영한다(브라질채권검색과 동일).
        // 그 외는 이전 선택(예: 브라질 국채) 값이 남지 않도록 일반과세로 되돌린다.
        fields.taxStatus = (countrySlug === "brazil"
          ? "비과세"
          : "일반과세") as TaxStatus;
        // 미국국채는 boerse-frankfurt API에 날짜계산기준/이자지급주기 정보가
        // 없어 건드리지 않고 있었는데, 그래서 이전에 남아있던 값(예: 기본값
        // "미국 30/360")이 그대로 쓰여 미국채권검색(ACT/ACT로 명시 반영)과
        // 같은 종목인데도 매수단가가 달라지는 문제가 있었다(실제 확인).
        // 미국국채는 시장 관행상 항상 ACT/ACT·6개월 이표라 미국채권검색과
        // 동일하게 명시적으로 반영한다. 브라질 USD 국채(브라질채권검색이
        // 다루는 BRL표시 국내채 NTN-F와는 별개)도 SEC 공시서류(2007년
        // 7.125% 2037만기 글로벌본드) 원문에 "computed on the basis of a
        // 360-day year of twelve 30-day months"(미국식 30/360), "pay
        // interest semi-annually"(6개월 이표)로 명시돼 있어 동일하게
        // 반영한다. 둘 다 안 하면 이전에 다른 종목에서 남은 값(예:
        // ACT/ACT나 Business/252)이 잘못 남을 수 있다.
        // boerse-frankfurt의 interestPaymentPeriod 필드는 거의 항상 null이라
        // 못 쓰지만, firstAnnualPayDate(첫 이자지급일)와 발행일 간격으로
        // 지급주기를 역산할 수 있다(getBondDetail에서 계산해 내려줌, 실제
        // 검증: Microsoft/Alphabet SEC 공시 원문과 정확히 일치). 국채가
        // 아닌 회사채도 이 값이 있으면 기본값(6개월) 대신 실제값을 쓴다.
        const realFrequency = frequencyFromMonths(data.couponFrequencyMonths);
        if (countrySlug === "united-states") {
          fields.calcBasis = "ACT/ACT" as CalcBasis;
          fields.couponFrequency = "6개월" as CouponFrequency;
        } else if (countrySlug === "brazil") {
          fields.calcBasis = "미국 30/360" as CalcBasis;
          fields.couponFrequency = "6개월" as CouponFrequency;
        } else {
          // 이 API는 국가(주권) 발행자가 아니면 날짜계산기준을 확정적으로
          // 알 방법이 없다(회사채마다 다름). 위 두 경우가 아니면 이전에
          // 선택했던 국채의 값(예: ACT/ACT)이 남지 않도록 앱 기본값(미국
          // 30/360)으로 되돌린다. 실제 종목의 진짜 기준과 다를 수 있으니
          // 필요시 직접 확인/수정해야 한다. 이자지급주기는 위에서 구한
          // 실제값이 있으면 그걸, 없으면 기본값(6개월)을 쓴다.
          fields.calcBasis = "미국 30/360" as CalcBasis;
          fields.couponFrequency = (realFrequency ?? "6개월") as CouponFrequency;
        }
        onApply(fields);
        setDetailSlug(data.slug ?? bond.slug ?? null);
        // 국채(미국/브라질)는 날짜계산기준이 시장 관행상 확정적이라 그대로
        // 믿을 수 있지만, 그 외 발행자(회사채 등)는 날짜계산기준을 API가
        // 안 줘서 앱 기본값을 채워 넣은 것뿐이라 실제 종목의 진짜 기준과
        // 다를 수 있다는 걸 알려준다. 지급주기/날짜계산기준 각각 실제값을
        // 구했는지(boerse-frankfurt 발행일 역산 또는 아래 SEC 매칭)에 따라
        // 문구를 갱신한다 — 둘 다 실제값이면 "OK"(예: SEC 매칭은 됐지만
        // 지급주기 추출은 안 되는 경우가 있어, calcBasis만으로 OK 처리하면
        // 안 되고 반드시 이 함수로 다시 계산해야 한다).
        const computeStatus = (calcBasisConfirmed: boolean, frequencyConfirmed: boolean) => {
          if (countrySlug === "united-states" || countrySlug === "brazil") return "OK";
          if (calcBasisConfirmed && frequencyConfirmed) return "OK";
          if (frequencyConfirmed) {
            return "날짜계산기준은 기본값(미국 30/360)입니다. 실제 종목과 다를 수 있어 직접 확인이 필요합니다.";
          }
          return "날짜계산기준/이자지급주기는 기본값(미국 30/360·6개월)입니다. 실제 종목과 다를 수 있어 직접 확인이 필요합니다.";
        };
        setStatus(computeStatus(false, realFrequency !== null));
        setOpen(false);

        if (countrySlug) {
          fetch(`/api/country-rating?slug=${encodeURIComponent(countrySlug)}`)
            .then((res) => res.json())
            .then((rated: { rating?: string | null }) => {
              if (rated.rating) onApply({ creditRating: rated.rating });
            })
            .catch(() => {});
          // 국채도 발행국이 SEC에 직접 FWP를 낸 경우가 있다(실제 확인:
          // 대한민국 정부의 달러표시 글로벌본드 — CIK 873465). 신용등급은
          // 위 tradingeconomics 국가등급을 그대로 쓰고, 여기서는 지급주기/
          // 날짜계산기준만 실제값이 있으면 기본값을 덮어쓴다. 미국/브라질은
          // 이미 시장관행상 확정값을 위에서 명시 반영해서 제외한다.
          if (
            selectedIssuer &&
            countrySlug !== "united-states" &&
            countrySlug !== "brazil"
          ) {
            fetch(
              `/api/us-company-rating?name=${encodeURIComponent(selectedIssuer)}&isin=${encodeURIComponent(bond.isin)}`
            )
              .then((res) => res.json())
              .then(
                (rated: {
                  couponFrequencyMonths?: number | null;
                  calcBasis?: string | null;
                }) => {
                  const update: Partial<BondLayoutInput> = {};
                  const frequency = frequencyFromMonths(rated.couponFrequencyMonths ?? null);
                  if (frequency) update.couponFrequency = frequency;
                  if (
                    rated.calcBasis &&
                    CALC_BASIS_VALUES.includes(rated.calcBasis as CalcBasis)
                  ) {
                    update.calcBasis = rated.calcBasis as CalcBasis;
                  }
                  if (Object.keys(update).length > 0) {
                    onApply(update);
                    setStatus(
                      computeStatus(
                        !!update.calcBasis,
                        !!update.couponFrequency || realFrequency !== null
                      )
                    );
                  }
                }
              )
              .catch(() => {});
          }
        } else if (selectedIssuer) {
          // 국채가 아닌 회사채는 boerse-frankfurt에 신용등급/지급주기/
          // 날짜계산기준 정보가 전혀 없다. 같은 회사가 SEC(미국채권검색)에도
          // 등록돼 있으면 그쪽 데이터를 대신 반영한다(발행자명이 구두점만
          // 다른 경우가 많아 정규화 후 정확히 일치할 때만 매칭 — 실제 확인:
          // Apple/Meta/Microsoft/Alphabet). 이 ISIN으로 SEC에도 실제 발행한
          // 적이 있으면(=isin까지 일치) 위에서 기본값(6개월·미국 30/360)으로
          // 채운 지급주기/날짜계산기준도 그 트랜치의 진짜 값으로 덮어쓴다
          // (실제 확인: Alphabet EUR채 XS3363386460은 연 1회 지급인데 기본값
          // 6개월이 잘못 적용됐었다). 매칭 실패 시 조용히 무시한다(기본값 유지).
          fetch(
            `/api/us-company-rating?name=${encodeURIComponent(selectedIssuer)}&isin=${encodeURIComponent(bond.isin)}`
          )
            .then((res) => res.json())
            .then(
              (rated: {
                rating?: string | null;
                couponFrequencyMonths?: number | null;
                calcBasis?: string | null;
              }) => {
                const update: Partial<BondLayoutInput> = {};
                if (rated.rating) update.creditRating = rated.rating;
                const frequency = frequencyFromMonths(rated.couponFrequencyMonths ?? null);
                if (frequency) update.couponFrequency = frequency;
                if (
                  rated.calcBasis &&
                  CALC_BASIS_VALUES.includes(rated.calcBasis as CalcBasis)
                ) {
                  update.calcBasis = rated.calcBasis as CalcBasis;
                }
                if (Object.keys(update).length > 0) {
                  onApply(update);
                  // 지급주기/날짜계산기준 각각 실제값을 구했는지에 따라
                  // 상태 메시지를 갱신한다.
                  setStatus(
                    computeStatus(
                      !!update.calcBasis,
                      !!update.couponFrequency || realFrequency !== null
                    )
                  );
                }
              }
            )
            .catch(() => {});
        }
      })
      .catch(() => setStatus("상세정보를 불러오지 못했습니다."));
  };

  const resetIssuer = () => {
    setSelectedIssuer(null);
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
        종목검색
      </button>

      {active && detailSlug && (
        <a
          href={`https://www.boerse-frankfurt.de/bond/${detailSlug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
        >
          상세페이지 열기
        </a>
      )}

      {active && quoteInfo && !open && (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{quoteInfo}</span>
      )}

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-80 rounded-lg border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {issuersError ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{issuersError}</p>
          ) : (
            <>
              {selectedIssuer && (
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-zinc-600 dark:text-zinc-300">
                    {selectedIssuer}
                  </span>
                  <button
                    type="button"
                    onClick={resetIssuer}
                    className="shrink-0 text-xs text-zinc-400 hover:underline"
                  >
                    ← 다른 발행자
                  </button>
                </div>
              )}
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  selectedIssuer ? "채권명/쿠폰으로 좁히기 (예: 5.4)" : "발행자명 입력 (예: META)"
                }
                className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-blue-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              />

              {!selectedIssuer && (
                <ul className="mt-2 max-h-56 overflow-y-auto">
                  {matchingIssuers.map((issuer) => (
                    <li key={issuer}>
                      <button
                        type="button"
                        onClick={() => selectIssuer(issuer)}
                        className="w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        {issuer}
                      </button>
                    </li>
                  ))}
                  {query.trim() && matchingIssuers.length === 0 && (
                    <li className="px-2 py-1 text-xs text-zinc-400">일치하는 발행자가 없습니다.</li>
                  )}
                </ul>
              )}

              {selectedIssuer && loadingBonds && (
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">불러오는 중...</p>
              )}

              {selectedIssuer && !loadingBonds && (
                <ul className="mt-2 max-h-56 overflow-y-auto">
                  {filteredBonds.map((bond) => (
                    <li key={bond.isin}>
                      <button
                        type="button"
                        onClick={() => selectBond(bond)}
                        className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        <span className="block truncate">{bond.name}</span>
                        <span className="text-xs text-zinc-400">{bond.isin}</span>
                      </button>
                    </li>
                  ))}
                  {filteredBonds.length === 0 && (
                    <li className="px-2 py-1 text-xs text-zinc-400">일치하는 종목이 없습니다.</li>
                  )}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {active && status && !open && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{status}</p>
      )}
    </div>
  );
}
