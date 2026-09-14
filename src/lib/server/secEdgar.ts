import { getRedis } from "@/lib/server/redis";
import { COUNTRY_ISSUER_SEC_CIK } from "@/lib/countryIssuerAliases";
import { addMonths, toDateString } from "@/lib/couponSchedule";

const USER_AGENT = "ChaeGwonSesangBondApp research-contact@chaegwonsesang.example";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const COMPANY_TTL_MS = 24 * 60 * 60 * 1000;
const REDIS_KEY = "us-companies-v1";
const REDIS_TTL_SECONDS = 24 * 60 * 60;

export interface CompanyInfo {
  cik: string;
  ticker: string;
  name: string;
}

// 메모리 캐시만 쓰면 Vercel 콜드스타트마다(=흔함) 약 1MB짜리 회사 목록을
// 매번 새로 받아야 했다(실제 겪음: 회사검색/상세조회 전체가 체감상 느려짐).
// Redis에도 캐시해 콜드스타트와 무관하게 공유되도록 한다.
let cachedCompanies: { list: CompanyInfo[]; fetchedAt: number } | null = null;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`SEC 요청 실패 (${res.status})`);
  return res.text();
}

/** SEC가 매일 갱신하는 전체 상장/등록 회사 티커·CIK 목록 (약 1MB) */
export async function getCompanies(): Promise<CompanyInfo[]> {
  if (cachedCompanies && Date.now() - cachedCompanies.fetchedAt < COMPANY_TTL_MS) {
    return cachedCompanies.list;
  }

  const redis = getRedis();
  if (redis) {
    try {
      const fromRedis = await redis.get<CompanyInfo[]>(REDIS_KEY);
      if (fromRedis) {
        cachedCompanies = { list: fromRedis, fetchedAt: Date.now() };
        return fromRedis;
      }
    } catch {
      // Redis 조회 실패는 무시하고 원본 소스로 폴백한다.
    }
  }

  const text = await fetchText(TICKERS_URL);
  const data = JSON.parse(text) as Record<
    string,
    { cik_str: number; ticker: string; title: string }
  >;
  const list = Object.values(data).map((v) => ({
    cik: String(v.cik_str).padStart(10, "0"),
    ticker: v.ticker,
    name: v.title,
  }));
  cachedCompanies = { list, fetchedAt: Date.now() };
  if (redis) {
    redis.set(REDIS_KEY, list, { ex: REDIS_TTL_SECONDS }).catch(() => {});
  }
  return list;
}

function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * 종목검색(boerse-frankfurt)의 발행자명("Meta Platforms Inc.")과 SEC의
 * 공식 회사명("Meta Platforms, Inc.")은 구두점/대소문자만 다른 경우가
 * 많다(실제 확인: Apple/Meta/Microsoft/Alphabet). 구두점을 제거하고 정확히
 * 일치할 때만 매칭해, 서로 다른 회사가 우연히 이어붙는 오매칭을 막는다.
 */
export async function findCompanyByName(name: string): Promise<CompanyInfo | null> {
  const target = normalizeCompanyName(name);
  if (!target) return null;
  const companies = await getCompanies();
  return companies.find((c) => normalizeCompanyName(c.name) === target) ?? null;
}

/**
 * 회사(findCompanyByName)뿐 아니라 국채(주권) 발행자도 SEC에 CIK가 있는
 * 경우(COUNTRY_ISSUER_SEC_CIK) CIK를 반환한다. 국가 발행자는
 * company_tickers.json에 없어 findCompanyByName만으로는 못 찾는다.
 */
export async function findCikByName(name: string): Promise<string | null> {
  const sovereignCik = COUNTRY_ISSUER_SEC_CIK[name];
  if (sovereignCik) return sovereignCik;
  const company = await findCompanyByName(name);
  return company?.cik ?? null;
}

export interface FilingSummary {
  accessionNumber: string;
  filedDate: string;
  indexUrl: string;
}

async function getFilings(
  cik: string,
  type: string,
  count = 20
): Promise<FilingSummary[]> {
  const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${type}&dateb=&owner=include&count=${count}&output=atom`;
  const xml = await fetchText(url);
  const entries: FilingSummary[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml))) {
    const block = m[1];
    const acc = block.match(/<accession-number>([^<]+)<\/accession-number>/);
    const href = block.match(/<filing-href>([^<]+)<\/filing-href>/);
    const filed = block.match(/Filed:(?:&lt;\/b&gt;|<\/b>)?\s*([\d-]+)/);
    if (acc && href) {
      entries.push({
        accessionNumber: acc[1],
        filedDate: filed ? filed[1] : "",
        indexUrl: href[1],
      });
    }
  }
  return entries;
}

/** 최근 채권 발행 시 제출되는 가격결정 조건표(FWP) 목록 */
export async function getFwpFilings(cik: string): Promise<FilingSummary[]> {
  return getFilings(cik, "FWP", 30);
}

async function getPrimaryDocUrl(indexUrl: string): Promise<string | null> {
  const html = await fetchText(indexUrl);
  const matches = [...html.matchAll(/href="([^"]+\.htm)"/g)].map((mm) => mm[1]);
  const candidate = matches.find(
    (href) =>
      href.includes("/Archives/edgar/data/") &&
      !href.startsWith("/ix?doc=") &&
      !href.endsWith("-index.htm")
  );
  if (!candidate) return null;
  return candidate.startsWith("http") ? candidate : `https://www.sec.gov${candidate}`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|tr|br|li|td)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&#8216;|&#145;|&#146;/g, "'")
    .replace(/&#8220;|&#8221;|&#147;|&#148;/g, '"')
    .replace(/&#8211;|&#8212;|&#150;|&#151;/g, "-")
    .replace(/&#128;|&#8364;/g, "€")
    .replace(/&yen;|&#165;/gi, "¥")
    .replace(/&pound;|&#163;/gi, "£")
    .replace(/&#160;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n");
}

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

function parseUsDate(text: string): string | null {
  const m = text.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[2].padStart(2, "0")}`;
}

function section(text: string, label: string, nextLabels: string[]): string | null {
  const startIdx = text.indexOf(label);
  if (startIdx === -1) return null;
  const rest = text.slice(startIdx + label.length);
  let endIdx = rest.length;
  for (const next of nextLabels) {
    const idx = rest.indexOf(next);
    if (idx !== -1 && idx < endIdx) endIdx = idx;
  }
  return rest.slice(0, endIdx).trim();
}

/**
 * "Settlement Date (T+5):"처럼 결제일수(T+n)가 발행마다 다른 라벨을 정확한
 * 문자열 대신 정규식으로 찾는다(실제 확인: Meta는 T+2, Microsoft는 T+5).
 */
function sectionByPattern(text: string, startPattern: RegExp, nextLabels: string[]): string | null {
  const m = text.match(startPattern);
  if (!m || m.index === undefined) return null;
  const rest = text.slice(m.index + m[0].length);
  let endIdx = rest.length;
  for (const next of nextLabels) {
    const idx = rest.indexOf(next);
    if (idx !== -1 && idx < endIdx) endIdx = idx;
  }
  return rest.slice(0, endIdx).trim();
}

const KNOWN_LABELS = [
  "Format:",
  "Issue:",
  "Title of Securities:",
  "Title:",
  "Trade Date:",
  "Settlement Date",
  "Denominations:",
  "Ratings:",
  "Ratings*:",
  "Long-Term Debt Ratings*:",
  "Long-Term Debt Ratings:",
  "Maturity Date:",
  "Maturity:",
  "Principal Amount:",
  "Public Offering Price:",
  "Price to Public:",
  "Coupon (Interest Rate):",
  "Coupon:",
  "Day Count Convention:",
  "Day Count Fraction:",
  "Yield to Maturity:",
  "Yield:",
  "Spread to Benchmark Treasury:",
  "Benchmark Treasury:",
  "Benchmark Treasury Price/Yield:",
  "Interest Payment Dates:",
  "Interest Payment Record Dates:",
  "Optional Redemption:",
  "Redemption:",
  "Optional Repayment Date(s):",
  "Optional Repayment Date:",
  "Repayment Date(s):",
  "Repayment Price:",
  "Net Proceeds:",
  "Joint Book-Running Managers:",
  "Sole Book-Running Manager:",
  "Passive Bookrunners:",
  "Co-Managers:",
  "Underwriters:",
  "CUSIP / Common Code / ISIN:",
  "CUSIP / ISIN:",
  "CUSIP/ISIN:",
  "CUSIP:",
  "ISIN:",
  "Use of Proceeds:",
  "Issuer:",
];

/** 문서마다 필드 순서가 달라, 배열 순서가 아니라 실제 텍스트에서 다음으로
 * 등장하는 라벨까지를 경계로 잡는다 */
function otherLabels(label: string): string[] {
  return KNOWN_LABELS.filter((l) => l !== label);
}

export interface BondTranche {
  label: string;
  maturityDate: string | null;
  couponRate: number | null;
  isin: string | null;
  rating: string | null;
  couponFrequencyMonths: number | null;
  settlementDate: string | null;
  calcBasis: string | null;
  /** par call일(YYYY-MM-DD). 명시적 날짜 또는 상대표현+만기로 계산. */
  parCallDate: string | null;
  /** "만기 N개월 전" 상대표현(개월). year 표현은 ×12. */
  parCallMonthsBeforeMaturity: number | null;
  /** make-whole 스프레드(bp). */
  makeWholeSpreadBps: number | null;
  /** "Optional Redemption" 섹션 앞부분(표시/디버그용). */
  redemptionText: string | null;
  /** 풋옵션(투자자 조기상환청구권) 행사일. 상환가는 액면(100%) 고정 가정. */
  putDate: string | null;
  /** 풋옵션 관련 원문 발췌(표시/디버그용). */
  putText: string | null;
}

export interface RedemptionTerms {
  parCallDate: string | null;
  parCallMonthsBeforeMaturity: number | null;
  makeWholeSpreadBps: number | null;
  redemptionText: string | null;
}

const EMPTY_REDEMPTION: RedemptionTerms = {
  parCallDate: null,
  parCallMonthsBeforeMaturity: null,
  makeWholeSpreadBps: null,
  redemptionText: null,
};

export interface PutTerms {
  putDate: string | null;
  putText: string | null;
}

const EMPTY_PUT: PutTerms = { putDate: null, putText: null };

/**
 * MTN 프로그램(Toyota Motor Credit·PACCAR Financial 등)의 FWP는 풋옵션을
 * "Optional Repayment Date(s):" 같은 라벨 필드로 담는다 — 옵션이 없으면
 * 필드 자체가 문서에 없다(실제 확인: PACCAR FWP는 "may not be repaid ...
 * at the option of the holder"만 있고 날짜 필드가 없음). 그래서 라벨
 * 부재만으로 "풋 없음"을 신뢰할 수 있어, 콜과 달리 문서 전체를 훑는 폴백
 * 정규식은 두지 않는다(오탐 위험 대신 미탐을 택함 — 드문 조항이라 미탐이
 * 더 안전). "Change of Control" 상환청구권(계약 트리거형, 일정과 무관)은
 * 이 라벨들과 겹치지 않아 자연히 걸러진다.
 */
function extractPutTerms(text: string): PutTerms {
  const raw =
    section(text, "Optional Repayment Date(s):", otherLabels("Optional Repayment Date(s):")) ??
    section(text, "Optional Repayment Date:", otherLabels("Optional Repayment Date:")) ??
    section(text, "Repayment Date(s):", otherLabels("Repayment Date(s):")) ??
    null;
  if (!raw) return EMPTY_PUT;
  const dateMatch = raw.match(/[A-Za-z]+ \d{1,2},\s*\d{4}/);
  const putDate = dateMatch ? parseUsDate(dateMatch[0]) : null;
  if (!putDate) return EMPTY_PUT;
  return { putDate, putText: raw.slice(0, 240).replace(/\s+/g, " ").trim() };
}

/**
 * FWP/424B의 "Optional Redemption" 조항에서 make-whole 스프레드와 par call일을
 * 뽑는다. par call은 명시적 날짜("on or after August 15, 2034") 또는 상대표현
 * ("the date that is 3 months prior to the maturity date")으로 적힌다 —
 * 후자는 maturityDate가 있으면 계산해 날짜화한다. best-effort 정규식.
 * (실제 확인: Target 2025 FWP — "treasury rate plus 10 basis points",
 * "1 month prior to the maturity date" / 2036 Notes는 15bp·"3 months prior".)
 */
function extractRedemptionTerms(
  text: string,
  maturityDate?: string | null
): RedemptionTerms {
  const raw = findRedemptionSection(text);
  return parseRedemptionSource(raw ?? text, raw !== null, maturityDate ?? null);
}

/** "Optional Redemption:"(또는 "Redemption:") 섹션 본문. 없으면 null. */
function findRedemptionSection(text: string): string | null {
  return (
    section(text, "Optional Redemption:", otherLabels("Optional Redemption:")) ??
    section(text, "Redemption:", otherLabels("Redemption:")) ??
    null
  );
}

/**
 * 문장 단위 분할. "U.S." 같은 한 글자 약어 뒤 마침표는 경계로 보지 않는다.
 * 다음 문장이 숫자로 시작하는 경우("... 2030. 2032 Notes: ...")도 경계로
 * 보고, 텀시트가 "YYYY Notes:" 라벨로 트랜치 절을 시작하는 서식(실제 확인:
 * Meta 2025-10-30 — 각 트랜치 조건이 "2032 Notes: At any time prior to …"로
 * 이어짐)은 그 라벨 앞에서도 나눈다. (텍스트는 htmlToText 후 공백이 한 칸으로
 * 정규화된 상태.)
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<!\b[A-Z])\.\s+(?=[A-Z0-9(])|(?=\b(?:19|20)\d{2}\s+Notes:)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 나열식(flat) 다중트랜치 문서의 redemption 섹션에서 특정 트랜치에 해당하는
 * 문장만 남긴다 — 그 트랜치 라벨("2030 Notes")을 언급하는 문장 + 어떤 트랜치
 * 라벨도 언급하지 않는(공통) 문장. 다른 트랜치만 언급한 문장은 제외한다.
 * (감사 F3 — 실제 확인: Meta 2025-10-30 FWP 6트랜치가 전부 1번 트랜치의
 * par call 2030-10-15·10bp로 복사돼 2065 Notes가 만기 35년 전 콜로 잡힘.)
 */
function scopeToTranche(text: string, label: string, allLabels: string[]): string {
  const target = label.toLowerCase();
  const others = allLabels
    .map((l) => l.toLowerCase())
    .filter((l) => l !== target);
  return splitSentences(text)
    .filter((s) => {
      const lower = s.toLowerCase();
      return lower.includes(target) || !others.some((o) => lower.includes(o));
    })
    .join(". ");
}

/**
 * 블록 경로 라벨("4.000% Notes due 2028")을 나열식 문서에서 쓰는 짧은 형태
 * ("2028 Notes")로 바꾼다. 424B 본문은 대개 짧은 형태로 트랜치를 지칭한다.
 */
function shortTrancheLabel(label: string): string {
  const direct = label.match(/\b(?:19|20)\d{2}\s+Notes\b/);
  if (direct) return direct[0];
  const due = label.match(/due\s+((?:19|20)\d{2})/i);
  return due ? `${due[1]} Notes` : label;
}

/**
 * 명시적 par call일. 우선순위: "on or after <date>" → "Par Call Date ... is
 * <date>" → (Apple류) "Prior to <date>, ... may redeem". 마지막 패턴은 문장
 * 단위로 보되 특별의무상환(SMR)·Change of Control 등 무관한 문장은 제외한다
 * (감사 F4 — 실제 확인: Lowe's 2025 FWP의 "If the Issuer does not consummate
 * the FBM Acquisition on or prior to August 19, 2027 ... required to redeem"이
 * par call로 잡혔고, "on or after" 패턴은 `\s+` 누락으로 절대 매치되지 않았다).
 */
function findExplicitParCallDate(source: string): string | null {
  const onOrAfter = source.match(/\bon or after\s+([A-Za-z]+ \d{1,2},\s*\d{4})/i);
  if (onOrAfter) return parseUsDate(onOrAfter[1]);

  const parCallLabel = source.match(
    /par call date[^.]{0,60}?(?:is|:|of)\s*([A-Za-z]+ \d{1,2},\s*\d{4})/i
  );
  if (parCallLabel) return parseUsDate(parCallLabel[1]);

  for (const s of splitSentences(source)) {
    if (!/redeem/i.test(s)) continue;
    if (/special mandatory|consummat|required to redeem|change of control/i.test(s)) {
      continue;
    }
    const priorTo = s.match(/\bprior to\s+([A-Za-z]+ \d{1,2},\s*\d{4})/i);
    if (priorTo) return parseUsDate(priorTo[1]);
  }
  return null;
}

/**
 * 명시적 날짜를 트랜치 만기 기준으로 검증한다: 만기보다 앞서고 지나치게 이르지
 * 않은(만기 3년≈37개월 이내) 날짜만 par call로 인정. 통과하면 개월수도 함께.
 */
function capParCall(
  parsedIso: string,
  maturity: Date
): { parCallDate: string; months: number } | null {
  const d = new Date(parsedIso);
  if (Number.isNaN(d.getTime())) return null;
  const monthsBefore = (maturity.getTime() - d.getTime()) / (30.44 * 24 * 3600 * 1000);
  if (monthsBefore > 0 && monthsBefore <= 37) {
    return { parCallDate: parsedIso, months: Math.round(monthsBefore) };
  }
  return null;
}

/**
 * redemption 본문(source)에서 make-whole 스프레드·par call일을 뽑는다.
 * `dedicated`는 source가 redemption 전용 섹션인지(true) 문서 전체인지(false) —
 * 전용 섹션이면 "plus N basis points"만으로도 스프레드로 인정한다.
 */
function parseRedemptionSource(
  source: string,
  dedicated: boolean,
  maturityDate: string | null
): RedemptionTerms {
  const raw = dedicated ? source : "";

  let makeWholeSpreadBps: number | null = null;
  // "(Adjusted) Treasury Rate / Reinvestment Rate ... plus N basis points".
  // rate와 plus 사이에 "(as defined below)" 등 어구가 끼기도 한다.
  const bpsM =
    source.match(
      /(?:treasury|reinvestment)\s+rate[^.]{0,90}?plus\s+([\d.]+)\s+basis points/i
    ) ||
    // 섹션이 redemption 전용이면 "plus N basis points" 자체가 make-whole 스프레드일 가능성이 높다.
    (raw ? raw.match(/plus\s+([\d.]+)\s+basis points/i) : null);
  if (bpsM) {
    makeWholeSpreadBps = parseFloat(bpsM[1]);
  } else {
    const pctM = source.match(
      /(?:treasury|reinvestment)\s+rate[^.]{0,90}?plus\s+([\d.]+)\s*%/i
    );
    if (pctM) makeWholeSpreadBps = Math.round(parseFloat(pctM[1]) * 100);
  }

  let parCallDate: string | null = null;
  let parCallMonthsBeforeMaturity: number | null = null;
  const mat = maturityDate ? new Date(maturityDate) : null;
  const matOk = mat && !Number.isNaN(mat.getTime()) ? mat : null;

  // 상대표현: "the date that is N month(s)/year(s) prior to the maturity date"
  const relM = source.match(
    /(\d+)\s+(month|year)s?\s+(?:prior to|before)\s+(?:the\s+)?(?:stated\s+)?maturity/i
  );
  if (relM) {
    const n = parseInt(relM[1], 10);
    parCallMonthsBeforeMaturity = /year/i.test(relM[2]) ? n * 12 : n;
    if (matOk) {
      parCallDate = toDateString(
        addMonths(matOk, -parCallMonthsBeforeMaturity)
      );
    }
  }

  // 명시적 날짜(findExplicitParCallDate) → 트랜치 만기 기준 캡(capParCall).
  // 만기를 모르면 캡을 걸 수 없어 그대로 둔다(만기 없는 트랜치는 어차피
  // 현금흐름 계산이 불가하므로 무해).
  if (!parCallDate) {
    const parsed = findExplicitParCallDate(source);
    if (parsed && matOk) {
      const capped = capParCall(parsed, matOk);
      if (capped) {
        parCallDate = capped.parCallDate;
        parCallMonthsBeforeMaturity = capped.months;
      }
    } else if (parsed && !matOk) {
      parCallDate = parsed;
    }
  }

  if (
    makeWholeSpreadBps === null &&
    parCallDate === null &&
    parCallMonthsBeforeMaturity === null
  ) {
    return EMPTY_REDEMPTION;
  }

  return {
    parCallDate,
    parCallMonthsBeforeMaturity,
    makeWholeSpreadBps,
    redemptionText: raw ? raw.slice(0, 240).replace(/\s+/g, " ").trim() : null,
  };
}

export interface FwpParseResult {
  tranches: BondTranche[];
  currency: string;
  issuer: string | null;
}

/** 트랜치(만기별) 라벨을 "2031 Notes" 같은 패턴으로 찾는다. 단일 발행이면 빈 배열. */
function findTrancheLabels(text: string): string[] {
  const matches = text.match(/\b(19|20)\d{2}\s+Notes\b/g);
  if (!matches) return [];
  return [...new Set(matches)];
}

function extractRating(text: string): string | null {
  // 발행사마다 "Ratings:"(예: Meta) 또는 "Long-Term Debt Ratings*:"/
  // "Long-Term Debt Ratings:"(예: Microsoft, 각주 별표가 붙기도 함)로
  // 라벨이 다르다(실제 원문으로 확인).
  const ratingsRaw =
    section(text, "Long-Term Debt Ratings*:", otherLabels("Long-Term Debt Ratings*:")) ??
    section(text, "Long-Term Debt Ratings:", otherLabels("Long-Term Debt Ratings:")) ??
    section(text, "Ratings*:", otherLabels("Ratings*:")) ??
    section(text, "Ratings:", otherLabels("Ratings:"));
  if (!ratingsRaw) return null;

  const classify = (agencyText: string) =>
    /Moody/i.test(agencyText)
      ? "무디스"
      : /Poor|S&P/i.test(agencyText)
        ? "S&P"
        : /Fitch/i.test(agencyText)
          ? "Fitch"
          : null;

  const results: string[] = [];

  // "Aa3 (Moody's Investors Service, Inc.)" 형태
  for (const m of ratingsRaw.matchAll(
    /([A-Za-z0-9+\-]{2,5})\s*\(([^)]*(?:Moody|Poor|Fitch)[^)]*)\)/gi
  )) {
    const agency = classify(m[2]);
    if (agency) results.push(`${agency}: ${m[1]}`);
  }

  // "Aaa (stable) by Moody's Investors Service, Inc." 형태
  for (const m of ratingsRaw.matchAll(
    /([A-Za-z0-9+\-]{2,5})\s*\([^)]{0,20}\)\s*by\s+([^.]{3,60})/gi
  )) {
    const agency = classify(m[2]);
    if (agency && !results.some((r) => r.startsWith(`${agency}:`))) {
      results.push(`${agency}: ${m[1]}`);
    }
  }

  // "Moody's, Aaa (negative outlook); S&P, AAA (stable outlook)" 형태
  // (기관명이 등급보다 먼저 나옴 — 실제 확인: Microsoft)
  for (const m of ratingsRaw.matchAll(
    /(Moody|S&P|Poor|Fitch)[^,;():]*,\s*([A-Za-z0-9+\-]{2,5})\s*\(/gi
  )) {
    const agency = classify(m[1]);
    if (agency && !results.some((r) => r.startsWith(`${agency}:`))) {
      results.push(`${agency}: ${m[2]}`);
    }
  }

  // "Moody's: Aa2 (Stable); S&P: AA+ (Stable)" 형태
  // (기관명과 등급 사이가 쉼표가 아니라 콜론 — 실제 확인: Alphabet/Google)
  for (const m of ratingsRaw.matchAll(
    /(Moody|S&P|Poor|Fitch)[^,;():]*:\s*([A-Za-z0-9+\-]{2,5})\s*\(/gi
  )) {
    const agency = classify(m[1]);
    if (agency && !results.some((r) => r.startsWith(`${agency}:`))) {
      results.push(`${agency}: ${m[2]}`);
    }
  }

  return results.length > 0 ? results.join(" / ") : null;
}

/**
 * 변동금리채(FRN)는 "Coupon: SOFR (...), plus 1.210% per annum (the
 * "Margin")"처럼 표면이율 자리에 마진(스프레드)만 적혀 있다(실제 확인:
 * HSBC Holdings). 정규식은 그 숫자를 그대로 뽑아버려 마치 1.21%가 실제
 * 표면이율인 것처럼 잘못 반영될 수 있다. 이 앱은 고정쿠폰 전제라 애초에
 * 변동금리채를 표현할 수 없으므로, 벤치마크 금리 키워드가 보이면 표면이율을
 * 추출하지 않는다(다른 필드가 이 값을 보고 채권을 걸러낼 수 있도록).
 */
function isFloatingRateCoupon(couponRaw: string): boolean {
  return /\bSOFR\b|\bLIBOR\b|\bEURIBOR\b|\bSONIA\b|\bFloating Rate\b/i.test(couponRaw);
}

function extractDayCountBasis(text: string): string | null {
  const explicit =
    section(text, "Day Count Convention:", otherLabels("Day Count Convention:")) ??
    section(text, "Day Count Fraction:", otherLabels("Day Count Fraction:"));
  const source = explicit ?? text;

  if (/30E\/360|European 30\/360/i.test(source)) return "유럽 30/360";
  if (/30\/360/i.test(explicit ?? "")) return "미국 30/360";
  if (/actual\/actual|act\/act/i.test(source)) return "ACT/ACT";
  if (/actual\/365|act\/365/i.test(source)) return "ACT/365";
  if (/actual\/360|act\/360/i.test(source)) return "ACT/360";
  if (/360-day year (of|consisting of) twelve 30-day months/i.test(source)) return "미국 30/360";
  return null;
}

/**
 * 여러 트랜치를 한 번에 묶어 발행하는 경우, "Interest Payment Dates:"
 * 하나에 트랜치별로 다른 지급일이 "For the 2024 Notes, ... For the 2023
 * Notes, 2028 Notes and 2031 Notes, ..."처럼 절 단위로 나뉘어 들어있다
 * (실제 확인: NVIDIA 2021년 발행 — 2024 Notes는 6/14·12/14, 나머지는
 * 6/15·12/15). trancheLabel을 안 넘기고 전체 텍스트에서 날짜를 세면 서로
 * 다른 트랜치의 지급일이 합쳐져 실제보다 더 자주 지급하는 것처럼(예:
 * 6개월인데 3개월로) 잘못 계산된다. trancheLabel이 언급된 절만 골라 그
 * 안에서만 센다.
 */
function extractCouponFrequencyMonths(text: string, trancheLabel?: string): number | null {
  const raw = section(text, "Interest Payment Dates:", otherLabels("Interest Payment Dates:")) ?? "";
  let scoped = raw;
  if (trancheLabel) {
    const clauses = raw.split(/(?=\bFor the\b)/i);
    const matched = clauses.find((c) => c.includes(trancheLabel));
    if (matched) scoped = matched;
  }
  const monthDayCount = new Set([...scoped.matchAll(/[A-Za-z]+ \d{1,2}\b/g)].map((m) => m[0])).size;
  if (monthDayCount === 1) return 12;
  if (monthDayCount === 2) return 6;
  if (monthDayCount === 4) return 3;
  return null;
}

function extractIssuer(text: string): string | null {
  const raw = section(text, "Issuer:", otherLabels("Issuer:"));
  if (!raw) return null;
  // "NVIDIA Corporation (the "Company")"처럼 뒤에 문서 내 지칭용 정의어구가
  // 붙는 경우가 많다(실제 확인: NVIDIA/Alphabet, Microsoft는 없음). 종목명에
  // 불필요하므로 제거한다.
  // "HSBC Holdings plc ("HSBC Holdings")"처럼 "the" 없이 약칭만 정의하는
  // 경우도 있다(실제 확인: HSBC Holdings).
  const trimmed = raw
    .replace(/\s*\((?:the\s+)?"[^"]*"\)\s*$/i, "")
    .trim();
  return trimmed.length > 0 && trimmed.length < 100 ? trimmed : null;
}

function extractSettlementDate(text: string): string | null {
  // 결제일수(T+n)가 발행마다 다르다(예: Meta T+2, Microsoft T+5). "(T+숫자)"
  // 부분을 정규식으로 흡수해 어떤 n이든 찾는다.
  const raw =
    sectionByPattern(text, /Settlement Date\s*\(T\+\d+\):\*?/, otherLabels("Settlement Date")) ??
    section(text, "Settlement Date:", otherLabels("Settlement Date"));
  return raw ? parseUsDate(raw) : null;
}

/** 트랜치 하나가 완결된 블록(Issuer:부터 다음 Issuer: 전까지)을 통째로 파싱한다 */
function parseTrancheBlock(block: string): Omit<BondTranche, "label"> {
  // 발행사마다 "Maturity:"(예: Meta) 또는 "Maturity Date:"(예: Microsoft,
  // Google)로 라벨이 다르다(실제 두 문서 원문으로 확인). 후자를 못 찾으면
  // 표면이율 말고는 아무것도 못 채우는 문제가 있었다.
  const maturityRaw =
    section(block, "Maturity Date:", otherLabels("Maturity Date:")) ??
    section(block, "Maturity:", otherLabels("Maturity:")) ??
    "";
  const couponRaw =
    section(block, "Coupon (Interest Rate):", otherLabels("Coupon (Interest Rate):")) ??
    section(block, "Coupon:", otherLabels("Coupon:")) ??
    "";
  const isinRaw =
    section(block, "CUSIP / Common Code / ISIN:", otherLabels("CUSIP / Common Code / ISIN:")) ??
    section(block, "CUSIP / ISIN:", otherLabels("CUSIP / ISIN:")) ??
    section(block, "CUSIP/ISIN:", otherLabels("CUSIP/ISIN:")) ??
    section(block, "ISIN:", otherLabels("ISIN:")) ??
    "";

  const maturityDate = parseUsDate(maturityRaw);
  const couponMatch = isFloatingRateCoupon(couponRaw) ? null : couponRaw.match(/\d+\.\d+%/);
  const isinMatch = isinRaw.match(/\b[A-Z]{2}[0-9A-Z]{9}\d\b/);

  return {
    maturityDate,
    couponRate: couponMatch ? parseFloat(couponMatch[0]) : null,
    isin: isinMatch ? isinMatch[0] : null,
    rating: extractRating(block),
    couponFrequencyMonths: extractCouponFrequencyMonths(block),
    settlementDate: extractSettlementDate(block),
    calcBasis: extractDayCountBasis(block),
    ...extractRedemptionTerms(block, maturityDate),
    ...extractPutTerms(block),
  };
}

/**
 * boerse-frankfurt와 달리 발행사·주간사마다 문서 서식이 달라 완벽하지 않은
 * best-effort 파서. 두 가지 실제 서식을 지원한다:
 * 1) 여러 트랜치가 각자 완결된 블록(Issuer:...Ratings:...CUSIP/ISIN:)으로 반복되는 서식
 * 2) 한 번의 공통 섹션(Ratings/Trade Date 등)에 트랜치별 값만 나열식으로 이어지는 서식
 */
export function parseFwp(html: string): FwpParseResult {
  const text = htmlToText(html).replace(/\s+/g, " ");
  // "$"/"USD"는 문서 어딘가(법률 상투구 등)에 우연히 섞여 나올 수 있어
  // 배제 조건으로 못 쓴다. 대신 실제 통화기호(¥/€/£)나 명칭이 하나라도
  // 있으면 그 통화로, 없으면 USD로 판정한다(실제 확인: Alphabet의 EUR/JPY
  // 유로본드 문서에는 $/USD가 아예 등장하지 않는다).
  const currency = /¥|JPY\b/.test(text)
    ? "JPY"
    : /€|EUR\b/.test(text)
      ? "EUR"
      : /£|GBP\b/.test(text)
        ? "GBP"
        : "USD";

  // "Net Proceeds to Issuer:"/"Gross Proceeds to Issuer:"처럼 실제 트랜치
  // 구분용 라벨이 아닌데 "Issuer:"로 끝나는 문구가 있다(실제 확인: HSBC
  // Holdings — 이 문구 하나 때문에 단일 트랜치 문서가 2개짜리 다중트랜치로
  // 잘못 인식돼 뒷부분(ISIN 포함)이 엉뚱하게 잘려나갔다). "to Issuer:"로
  // 끝나는 매치는 제외한다.
  const issuerIdxs = [...text.matchAll(/(?<!to )Issuer:/g)].map((m) => m.index);

  if (issuerIdxs.length >= 2) {
    const blocks = issuerIdxs.map((start, i) =>
      text.slice(start, issuerIdxs[i + 1] ?? text.length)
    );
    const trancheLabelMatches = text.match(/[\d.]+%[^.]{0,25}?Notes\s+due\s+(19|20)\d{2}/gi) ?? [];
    const tranches = blocks.map((block, i) => ({
      label: trancheLabelMatches[i] ?? "",
      ...parseTrancheBlock(block),
    }));
    return { tranches, currency, issuer: extractIssuer(blocks[0]) };
  }

  const maturityRaw =
    section(text, "Maturity Date:", otherLabels("Maturity Date:")) ??
    section(text, "Maturity:", otherLabels("Maturity:")) ??
    "";
  const trancheLabels = findTrancheLabels(maturityRaw);
  const couponRaw =
    section(text, "Coupon (Interest Rate):", otherLabels("Coupon (Interest Rate):")) ??
    section(text, "Coupon:", otherLabels("Coupon:")) ??
    "";
  const isinRaw =
    section(text, "CUSIP / Common Code / ISIN:", otherLabels("CUSIP / Common Code / ISIN:")) ??
    section(text, "CUSIP / ISIN:", otherLabels("CUSIP / ISIN:")) ??
    section(text, "CUSIP/ISIN:", otherLabels("CUSIP/ISIN:")) ??
    section(text, "ISIN:", otherLabels("ISIN:")) ??
    "";

  const maturityDates = [...maturityRaw.matchAll(/[A-Za-z]+ \d{1,2},\s*\d{4}/g)].map((m) => parseUsDate(m[0]));
  const coupons = isFloatingRateCoupon(couponRaw)
    ? []
    : [...couponRaw.matchAll(/\d+\.\d+%/g)].map((m) => parseFloat(m[0]));
  const isins = [...isinRaw.matchAll(/\b[A-Z]{2}[0-9A-Z]{9}\d\b/g)].map((m) => m[0]);

  // 국채(주권) 발행자 FWP 일부는 라벨 뒤에 콜론이 아예 없다(실제 확인:
  // 대한민국 정부 — "Maturity Date September 16, 2030", "Interest Rate
  // 1.000% per annum", "ISIN US50064FAS39"). 콜론 기반 추출이 실패하면
  // 라벨 바로 뒤 값을 정규식으로 직접 찾는다.
  if (maturityDates.length === 0) {
    const m = text.match(/Maturity Date\s+([A-Za-z]+ \d{1,2},\s*\d{4})/);
    if (m) maturityDates.push(parseUsDate(m[1]));
  }
  if (coupons.length === 0 && !isFloatingRateCoupon(text)) {
    const m = text.match(/Interest Rate\s+(\d+\.\d+)%/);
    if (m) coupons.push(parseFloat(m[1]));
  }
  if (isins.length === 0) {
    const m = text.match(/ISIN\s+([A-Z]{2}[0-9A-Z]{9}\d)\b/);
    if (m) isins.push(m[1]);
  }

  const shared = {
    rating: extractRating(text),
    settlementDate: extractSettlementDate(text),
    calcBasis: extractDayCountBasis(text),
  };

  // 나열식 서식은 "Optional Redemption" 섹션이 한 번만 나오고 그 안에 트랜치별
  // 조건이 문장으로 섞여 있다. 섹션을 한 번 찾은 뒤 트랜치 라벨로 문장을
  // 스코핑하고, 트랜치 만기를 넘겨 상대표현 날짜화·37개월 캡을 트랜치별로
  // 적용한다(감사 F3 — 이전엔 만기 null로 한 번 뽑아 전 트랜치에 복사했고
  // 캡도 우회됐다).
  const redemptionRaw = findRedemptionSection(text);
  const redemptionFor = (
    label: string | null,
    maturityDate: string | null
  ): RedemptionTerms => {
    if (redemptionRaw === null) {
      return parseRedemptionSource(text, false, maturityDate);
    }
    const scoped =
      label && trancheLabels.length > 1
        ? scopeToTranche(redemptionRaw, label, trancheLabels)
        : redemptionRaw;
    return parseRedemptionSource(scoped, true, maturityDate);
  };
  // 풋옵션은 상대표현이 없어(항상 명시적 날짜) 트랜치 간 공유해도 무방하다.
  const putTerms = extractPutTerms(text);

  const tranches: BondTranche[] =
    trancheLabels.length > 0
      ? trancheLabels.map((label, i) => ({
          label,
          maturityDate: maturityDates[i] ?? null,
          couponRate: coupons[i] ?? null,
          isin: isins[i] ?? null,
          couponFrequencyMonths: extractCouponFrequencyMonths(text, label),
          ...shared,
          ...redemptionFor(label, maturityDates[i] ?? null),
          ...putTerms,
        }))
      : [
          {
            label: "",
            maturityDate: maturityDates[0] ?? null,
            couponRate: coupons[0] ?? null,
            isin: isins[0] ?? null,
            couponFrequencyMonths: extractCouponFrequencyMonths(text),
            ...shared,
            ...redemptionFor(null, maturityDates[0] ?? null),
            ...putTerms,
          },
        ];

  return { tranches, currency, issuer: extractIssuer(text) };
}

/**
 * 종목검색(boerse-frankfurt)은 신용등급을 제공하지 않아, 같은 회사가 SEC에
 * 낸 가장 최근 FWP에서 등급만 뽑아 대신 채운다. 등급은 발행마다가 아니라
 * 회사 단위로 큰 변화가 없어(무디스/S&P 장기신용등급) 최근 발행분 값을
 * 그대로 써도 무방하다. 최근 파일 하나가 라벨 형식 문제 등으로 실패할 수
 * 있어 최근 3건까지 순서대로 시도한다.
 */
export async function getLatestRating(cik: string): Promise<string | null> {
  const filings = await getFwpFilings(cik);
  for (const filing of filings.slice(0, 3)) {
    try {
      const docUrl = await getPrimaryDocUrl(filing.indexUrl);
      if (!docUrl) continue;
      const html = await fetchText(docUrl);
      const { tranches } = parseFwp(html);
      const rated = tranches.find((t) => t.rating);
      if (rated?.rating) return rated.rating;
    } catch {
      // 이 파일링은 건너뛰고 다음으로 시도한다.
    }
  }
  return null;
}

export async function fetchFwpDetail(
  indexUrl: string,
  cik: string,
  filedDate: string
): Promise<FwpParseResult> {
  const docUrl = await getPrimaryDocUrl(indexUrl);
  if (!docUrl) throw new Error("FWP 문서를 찾을 수 없습니다.");
  const html = await fetchText(docUrl);
  const result = parseFwp(html);

  if (result.tranches.some((t) => !t.calcBasis)) {
    const fallback = await findDayCountBasis(cik, filedDate).catch(() => null);
    if (fallback) {
      for (const t of result.tranches) {
        if (!t.calcBasis) t.calcBasis = fallback;
      }
    }
  }

  // 콜조항(make-whole 스프레드·par call일)이 FWP에 없으면 같은 발행의 424B에서
  // 찾는다. 424B 본문도 트랜치별로 문장을 스코핑하고 각 트랜치 만기로 캡을
  // 건다(감사 F3 — 이전엔 1번 트랜치 만기로 뽑은 명시일자를 전 트랜치에 복사).
  const needsRedemption = (
    t: Pick<RedemptionTerms, "makeWholeSpreadBps" | "parCallDate" | "parCallMonthsBeforeMaturity">
  ) =>
    t.makeWholeSpreadBps === null &&
    t.parCallDate === null &&
    t.parCallMonthsBeforeMaturity === null;
  if (result.tranches.some(needsRedemption)) {
    const text424 = await find424BText(cik, filedDate).catch(() => null);
    if (text424) {
      const raw424 = findRedemptionSection(text424);
      const labels = result.tranches
        .map((t) => shortTrancheLabel(t.label))
        .filter(Boolean);
      for (const t of result.tranches) {
        if (!needsRedemption(t)) continue;
        const scoped =
          raw424 && t.label && labels.length > 1
            ? scopeToTranche(raw424, shortTrancheLabel(t.label), labels)
            : raw424;
        const terms = scoped
          ? parseRedemptionSource(scoped, true, t.maturityDate)
          : parseRedemptionSource(text424, false, t.maturityDate);
        if (needsRedemption(terms)) continue;
        t.makeWholeSpreadBps = terms.makeWholeSpreadBps;
        t.parCallDate = terms.parCallDate;
        t.parCallMonthsBeforeMaturity = terms.parCallMonthsBeforeMaturity;
        if (!t.redemptionText && terms.redemptionText) {
          t.redemptionText = terms.redemptionText;
        }
      }
    }
  }

  // 풋옵션(투자자 조기상환청구권)도 FWP에 없으면 같은 발행의 424B에서 찾는다.
  if (result.tranches.some((t) => t.putDate === null)) {
    const putTerms = await findPutTerms(cik, filedDate).catch(() => null);
    if (putTerms) {
      for (const t of result.tranches) {
        if (t.putDate === null) {
          t.putDate = putTerms.putDate;
          t.putText = putTerms.putText;
        }
      }
    }
  }

  return result;
}

/**
 * 같은 회사가 FWP와 비슷한 시점에 낸 424B(본 증권신고서 보충)에서 "Optional
 * Redemption" 조항을 찾는다. findDayCountBasis와 동일한 구조 — 424B5는 보통
 * FWP 1~2일 뒤 제출되므로 ±5일로 잡는다.
 */
export async function findRedemptionTerms(
  cik: string,
  fwpFiledDate: string,
  maturityDate?: string | null
): Promise<RedemptionTerms | null> {
  const text = await find424BText(cik, fwpFiledDate);
  if (!text) return null;
  const terms = extractRedemptionTerms(text, maturityDate ?? null);
  if (
    terms.makeWholeSpreadBps === null &&
    terms.parCallDate === null &&
    terms.parCallMonthsBeforeMaturity === null
  ) {
    return null;
  }
  return terms;
}

/**
 * FWP와 비슷한 시점(±5일)에 같은 회사가 낸 424B 본문을 정규화 텍스트로 돌려준다.
 * fetchFwpDetail의 콜 폴백이 트랜치별로 스코핑·캡을 걸 수 있도록 파싱 전
 * 원문을 그대로 넘긴다.
 */
async function find424BText(
  cik: string,
  fwpFiledDate: string
): Promise<string | null> {
  const filings = await getFilings(cik, "424B", 10);
  const target = filings.find((f) => {
    if (!fwpFiledDate || !f.filedDate) return false;
    const d1 = new Date(fwpFiledDate).getTime();
    const d2 = new Date(f.filedDate).getTime();
    return Math.abs(d1 - d2) <= 5 * 24 * 60 * 60 * 1000;
  });
  if (!target) return null;

  const docUrl = await getPrimaryDocUrl(target.indexUrl);
  if (!docUrl) return null;
  const html = await fetchText(docUrl);
  return htmlToText(html).replace(/\s+/g, " ");
}

/**
 * findRedemptionTerms와 동일 구조로, 같은 424B에서 풋옵션(투자자 조기상환
 * 청구권)을 찾는다.
 */
export async function findPutTerms(
  cik: string,
  fwpFiledDate: string
): Promise<PutTerms | null> {
  const filings = await getFilings(cik, "424B", 10);
  const target = filings.find((f) => {
    if (!fwpFiledDate || !f.filedDate) return false;
    const d1 = new Date(fwpFiledDate).getTime();
    const d2 = new Date(f.filedDate).getTime();
    return Math.abs(d1 - d2) <= 5 * 24 * 60 * 60 * 1000;
  });
  if (!target) return null;

  const docUrl = await getPrimaryDocUrl(target.indexUrl);
  if (!docUrl) return null;
  const html = await fetchText(docUrl);
  const text = htmlToText(html).replace(/\s+/g, " ");
  const terms = extractPutTerms(text);
  return terms.putDate === null ? null : terms;
}

export interface BondListItem {
  label: string;
  isin: string | null;
  maturityDate: string | null;
  couponRate: number | null;
  indexUrl: string;
  filedDate: string;
}

/**
 * 종목검색(boerse-frankfurt)처럼 회사 선택 즉시 검색 가능한 평면 목록을 만들기
 * 위해, 최근 N건의 FWP를 미리 받아 트랜치를 하나로 합친다. 목록 단계에서는
 * day-count 424B 폴백 조회 없이 가볍게 처리하고(느려지는 것 방지), 신용등급/
 * 지급주기/날짜계산기준 등 나머지 값은 사용자가 실제 선택했을 때 개별 상세조회로
 * 채운다.
 */
export async function getRecentBondList(
  cik: string,
  maxOfferings = 15,
  // 미국채권검색 목록 용도(기본값)에서는 USD 채권만 남긴다. 종목검색의
  // ISIN 매칭(findBondByIsin)은 boerse-frankfurt가 이미 다른 통화(EUR 등)
  // 채권도 보여주고 있어 통화와 무관하게 전부 찾아야 하므로 false로 끈다.
  usdOnly = true
): Promise<BondListItem[]> {
  const offerings = (await getFwpFilings(cik)).slice(0, maxOfferings);
  const results = await Promise.all(
    offerings.map(async (offering) => {
      try {
        const docUrl = await getPrimaryDocUrl(offering.indexUrl);
        if (!docUrl) return [];
        const html = await fetchText(docUrl);
        const { tranches, currency } = parseFwp(html);
        // 미국채권검색은 USD 채권 전용이다. 같은 회사라도 해외법인 명의로
        // EUR/JPY 등 다른 통화로 발행하는 경우가 있어(실제 확인: Alphabet
        // 의 €9B 유로본드) 이 회사채 오퍼링 전체를 걸러낸다.
        if (usdOnly && currency !== "USD") return [];
        // FWP는 채권 가격결정조건표 말고도 증자 등 다른 공시에도 쓰인다
        // (실제 확인: Alphabet의 $84.75B 자기자본 조달 보도자료가 FWP로
        // 올라온 사례 — 만기/쿠폰/ISIN이 전혀 없어 "만기 -"로만 뜨는 빈
        // 항목이었다). 만기일이 없으면 채권이 아닌 것으로 보고 걸러낸다.
        // 표면이율이 없으면(JPMorgan 등이 다수 발행하는 "구조화 상품"
        // Structured Note — 특정 주가에 연동된 조건부수익 노트로 고정쿠폰
        // 자체가 없음, 실제 확인: "7.5m NEM Digital Barrier Notes",
        // "No interest payments" 명시) 이 앱의 고정쿠폰 현금흐름 모델로는
        // 표현할 수 없으므로 함께 걸러낸다.
        return tranches
          .filter((t) => t.maturityDate !== null && t.couponRate !== null)
          .map((t) => ({
            label: t.label,
            isin: t.isin,
            maturityDate: t.maturityDate,
            couponRate: t.couponRate,
            indexUrl: offering.indexUrl,
            filedDate: offering.filedDate,
          }));
      } catch {
        return [];
      }
    })
  );
  // FWP 공시 순서(최근 제출일 순)로 섞여 나오면 같은 만기끼리 묶어보기 어렵다.
  // 브라질채권검색/미국국채와 동일하게 만기일 기준 오름차순으로 정렬한다
  // (이 시점에는 위 필터에서 maturityDate가 없는 항목은 이미 걸러졌다).
  return results
    .flat()
    .sort((a, b) => (a.maturityDate ?? "") < (b.maturityDate ?? "") ? -1 : 1);
}

/**
 * 종목검색(boerse-frankfurt)은 이자지급주기/날짜계산기준을 전혀 제공하지
 * 않아 앱 기본값(6개월·미국 30/360)을 채워 넣는데, 실제로는 다른 경우가
 * 있다(실제 확인: Alphabet EUR채 XS3363386460은 연 1회 지급인데 기본값
 * 6개월이 잘못 적용됨). 같은 회사가 SEC에도 등록돼 있고 이 ISIN으로 실제
 * 발행한 적이 있으면, 그 트랜치의 진짜 값(등급/지급주기/날짜계산기준)을
 * 대신 쓴다.
 */
/**
 * getRecentBondList는 최근 N건(기본 15건)만 훑는데, HSBC처럼 발행이 잦은
 * 회사는 몇 년 전 채권이 그 범위 밖으로 밀려나 못 찾는다(실제 확인:
 * HSBC 2020년 채권 US404280CK33). 조회범위를 무작정 늘리면 SEC 요청이
 * 비례해서 늘어 느려지고 429/503 위험도 커진다. 대신 EDGAR 전문검색
 * (efts.sec.gov, 전체 공시 이력을 인덱싱해둠)에 ISIN을 그대로 검색하면
 * 요청 1번으로 정확한 문서를 즉시 찾을 수 있다.
 */
async function findFwpByIsinFullText(
  isin: string
): Promise<{ indexUrl: string; filedDate: string; cik: string } | null> {
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22${isin}%22&forms=FWP`;
    const json = await fetchText(url);
    const data = JSON.parse(json) as {
      hits?: {
        hits?: Array<{ _source?: { ciks?: string[]; adsh?: string; file_date?: string } }>;
      };
    };
    const source = data.hits?.hits?.[0]?._source;
    const cikRaw = source?.ciks?.[0];
    const adsh = source?.adsh;
    if (!cikRaw || !adsh) return null;
    const cik = String(parseInt(cikRaw, 10));
    const adshNoDashes = adsh.replace(/-/g, "");
    const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${adshNoDashes}/${adsh}-index.htm`;
    return { indexUrl, filedDate: source?.file_date ?? "", cik: cikRaw };
  } catch {
    return null;
  }
}

export async function findBondByIsin(cik: string, isin: string): Promise<BondTranche | null> {
  const list = await getRecentBondList(cik, 15, false);
  const match = list.find((item) => item.isin === isin);
  if (match) {
    const detail = await fetchFwpDetail(match.indexUrl, cik, match.filedDate);
    return detail.tranches.find((t) => t.isin === isin) ?? null;
  }

  const found = await findFwpByIsinFullText(isin);
  if (!found) return null;
  const detail = await fetchFwpDetail(found.indexUrl, found.cik, found.filedDate);
  return detail.tranches.find((t) => t.isin === isin) ?? null;
}

/**
 * 화면의 콜/풋 체크박스 재조회용 — cik 없이 ISIN만으로 콜/풋 조항을 다시
 * 조회한다. 미국채권검색을 거치지 않고 체크박스만 켰을 때 쓰인다.
 * `findFwpByIsinFullText`(cik 후보 목록 스캔 없이 EDGAR 전문검색으로 바로
 * 찾음)로 문서를 찾고, `fetchFwpDetail`(day-count·콜·풋 424B 폴백 전부 포함)
 * 로 상세 조회한다. 문서 자체를 못 찾으면 null("확인 불가" — "조항 없음
 * 확인됨"과는 다르게 취급해야 한다).
 */
export async function findCallPutTermsByIsin(
  isin: string
): Promise<BondTranche | null> {
  const found = await findFwpByIsinFullText(isin);
  if (!found) return null;
  const detail = await fetchFwpDetail(found.indexUrl, found.cik, found.filedDate);
  return detail.tranches.find((t) => t.isin === isin) ?? detail.tranches[0] ?? null;
}

/** 같은 회사가 FWP와 비슷한 시점에 낸 424B(본 증권신고서)에서 day-count 관용구를 찾는다 */
export async function findDayCountBasis(
  cik: string,
  fwpFiledDate: string
): Promise<string | null> {
  const filings = await getFilings(cik, "424B", 10);
  const target = filings.find((f) => {
    if (!fwpFiledDate || !f.filedDate) return false;
    const d1 = new Date(fwpFiledDate).getTime();
    const d2 = new Date(f.filedDate).getTime();
    return Math.abs(d1 - d2) <= 3 * 24 * 60 * 60 * 1000;
  });
  if (!target) return null;

  const docUrl = await getPrimaryDocUrl(target.indexUrl);
  if (!docUrl) return null;
  const html = await fetchText(docUrl);
  const text = htmlToText(html).replace(/\s+/g, " ");

  if (/360-day year (of|consisting of) twelve 30-day months/i.test(text)) return "미국 30/360";
  if (/actual\/360|actual number of days.{0,20}360-day/i.test(text)) return "ACT/360";
  if (/actual\/365/i.test(text)) return "ACT/365";
  if (/actual\/actual/i.test(text)) return "ACT/ACT";
  return null;
}
