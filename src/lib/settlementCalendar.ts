/**
 * 결제일(T+n 영업일) 계산용 시장별 휴장 캘린더.
 *
 * 결제일은 신탁계약일에서 "영업일" n일 뒤이므로 주말만 빼면 연휴 앞뒤에서
 * 실제 결제일과 어긋난다(감사 F12). 거래통화 기준으로 결제가 일어나는 시장의
 * 휴장일을 적용한다:
 * - KRW → 한국(관공서의 공휴일에 관한 규정 + 대체공휴일)
 * - USD → 미국 채권시장(SIFMA 권고 휴장일 ≈ 연방공휴일 + 성금요일)
 * - Business/252(브라질 국채) → ANBIMA/B3 (`brazilCalendar.ts`)
 * - 그 외 통화 → 주말만 제외
 *
 * 임시공휴일·선거일은 정부가 그때그때 지정하므로 아래 표에 알려진 것만 넣었다.
 * 빠진 날이 있으면 화면의 결제일 영업일수를 직접 고쳐 맞출 수 있다.
 *
 * 모든 날짜는 UTC 자정 기준.
 */
import { CalcBasis } from "@/types/bondLayout";
import { easterSunday, isBrazilBusinessDay } from "@/lib/brazilCalendar";

export type SettlementCalendar = "KR" | "US" | "BR" | "NONE";

function utc(year: number, month1: number, day: number): Date {
  return new Date(Date.UTC(year, month1 - 1, day));
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function dateKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/** n번째(1부터) 특정 요일. weekday: 0=일 … 6=토 */
function nthWeekday(year: number, month1: number, weekday: number, n: number): Date {
  const first = utc(year, month1, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return addDays(first, offset + (n - 1) * 7);
}

function lastWeekday(year: number, month1: number, weekday: number): Date {
  const last = utc(year, month1 + 1, 0);
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return addDays(last, -offset);
}

// ---------------------------------------------------------------------------
// 한국
// ---------------------------------------------------------------------------

/**
 * 음력 공휴일(설날·부처님오신날·추석 당일)의 양력 날짜. 음력 변환 알고리즘 대신
 * 연도별 표를 쓴다 — 표 밖 연도는 음력 공휴일 없이(고정 공휴일 + 주말만) 계산된다.
 */
const KR_LUNAR_HOLIDAYS: Record<number, { seollal: string; buddha: string; chuseok: string }> = {
  2024: { seollal: "02-10", buddha: "05-15", chuseok: "09-17" },
  2025: { seollal: "01-29", buddha: "05-05", chuseok: "10-06" },
  2026: { seollal: "02-17", buddha: "05-24", chuseok: "09-25" },
  2027: { seollal: "02-06", buddha: "05-13", chuseok: "09-15" },
  2028: { seollal: "01-26", buddha: "05-02", chuseok: "10-03" },
  2029: { seollal: "02-13", buddha: "05-20", chuseok: "09-22" },
  2030: { seollal: "02-03", buddha: "05-09", chuseok: "09-12" },
};

/** 임시공휴일·선거일(정부 지정, 알려진 것만). */
const KR_ADHOC_HOLIDAYS: string[] = [
  "2024-04-10", // 제22대 국회의원 선거
  "2024-10-01", // 국군의 날 임시공휴일
  "2025-01-27", // 설 연휴 임시공휴일
  "2025-06-03", // 제21대 대통령 선거
  "2025-10-10", // 추석 연휴 임시공휴일
  "2026-06-03", // 제9회 전국동시지방선거
  "2028-04-12", // 제23대 국회원의원 선거
  "2030-06-05", // 제10회 전국동시지방선거
];

function parseMonthDay(year: number, md: string): Date {
  const [m, d] = md.split("-").map(Number);
  return utc(year, m, d);
}

const krCache = new Map<number, Set<string>>();

/**
 * 대체공휴일 규정(2023-05 개정 기준):
 * - 설·추석 연휴: 다른 공휴일 또는 **일요일**과 겹치면 다음 첫 평일.
 * - 3·1절·어린이날·부처님오신날·광복절·개천절·한글날·성탄절: 토/일 또는
 *   다른 공휴일과 겹치면 다음 첫 평일.
 * - 신정·현충일·선거일·임시공휴일: 대체 없음.
 */
function koreanHolidaysOfYear(year: number): Set<string> {
  const cached = krCache.get(year);
  if (cached) return cached;

  type H = { date: Date; substitute: "none" | "sunday" | "weekend" };
  const list: H[] = [
    { date: utc(year, 1, 1), substitute: "none" }, // 신정
    { date: utc(year, 3, 1), substitute: "weekend" }, // 삼일절
    { date: utc(year, 5, 5), substitute: "weekend" }, // 어린이날
    { date: utc(year, 6, 6), substitute: "none" }, // 현충일
    { date: utc(year, 8, 15), substitute: "weekend" }, // 광복절
    { date: utc(year, 10, 3), substitute: "weekend" }, // 개천절
    { date: utc(year, 10, 9), substitute: "weekend" }, // 한글날
    { date: utc(year, 12, 25), substitute: "weekend" }, // 성탄절
  ];
  const lunar = KR_LUNAR_HOLIDAYS[year];
  if (lunar) {
    const seollal = parseMonthDay(year, lunar.seollal);
    const chuseok = parseMonthDay(year, lunar.chuseok);
    for (const off of [-1, 0, 1]) {
      list.push({ date: addDays(seollal, off), substitute: "sunday" });
      list.push({ date: addDays(chuseok, off), substitute: "sunday" });
    }
    list.push({ date: parseMonthDay(year, lunar.buddha), substitute: "weekend" });
  }
  for (const iso of KR_ADHOC_HOLIDAYS) {
    if (iso.startsWith(`${year}-`)) {
      const [, m, d] = iso.split("-").map(Number);
      list.push({ date: utc(year, m, d), substitute: "none" });
    }
  }
  list.sort((a, b) => a.date.getTime() - b.date.getTime());

  const set = new Set<string>();
  for (const h of list) {
    const key = dateKey(h.date);
    const dow = h.date.getUTCDay();
    const overlaps = set.has(key);
    set.add(key);
    const needsSubstitute =
      h.substitute !== "none" &&
      (overlaps ||
        dow === 0 ||
        (h.substitute === "weekend" && dow === 6));
    if (!needsSubstitute) continue;
    let sub = addDays(h.date, 1);
    while (isWeekend(sub) || set.has(dateKey(sub))) sub = addDays(sub, 1);
    set.add(dateKey(sub));
  }
  krCache.set(year, set);
  return set;
}

// ---------------------------------------------------------------------------
// 미국 (SIFMA 채권시장 휴장일)
// ---------------------------------------------------------------------------

/** 고정일 공휴일의 관측일: 토요일이면 금요일, 일요일이면 월요일. */
function observed(date: Date): Date {
  const dow = date.getUTCDay();
  if (dow === 6) return addDays(date, -1);
  if (dow === 0) return addDays(date, 1);
  return date;
}

const usCache = new Map<number, Set<string>>();

function usHolidaysOfYear(year: number): Set<string> {
  const cached = usCache.get(year);
  if (cached) return cached;

  const dates = [
    observed(utc(year, 1, 1)), // New Year's Day
    nthWeekday(year, 1, 1, 3), // MLK Day
    nthWeekday(year, 2, 1, 3), // Presidents' Day
    addDays(easterSunday(year), -2), // Good Friday (SIFMA 휴장, 연방공휴일 아님)
    lastWeekday(year, 5, 1), // Memorial Day
    observed(utc(year, 7, 4)), // Independence Day
    nthWeekday(year, 9, 1, 1), // Labor Day
    nthWeekday(year, 10, 1, 2), // Columbus Day (채권시장 휴장)
    observed(utc(year, 11, 11)), // Veterans Day (채권시장 휴장)
    nthWeekday(year, 11, 4, 4), // Thanksgiving
    observed(utc(year, 12, 25)), // Christmas
  ];
  if (year >= 2022) dates.push(observed(utc(year, 6, 19))); // Juneteenth
  // 12/31이 토요일이면 다음 해 1/1 관측일(12/30 금)이 전년도에 떨어진다.
  const nextNewYear = observed(utc(year + 1, 1, 1));
  if (nextNewYear.getUTCFullYear() === year) dates.push(nextNewYear);

  const set = new Set(dates.map(dateKey));
  usCache.set(year, set);
  return set;
}

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

export function getSettlementCalendar(
  calcBasis: CalcBasis | undefined,
  tradeCurrency: string | undefined
): SettlementCalendar {
  if (calcBasis === "Business/252") return "BR";
  if (tradeCurrency === "KRW") return "KR";
  if (tradeCurrency === "USD") return "US";
  return "NONE";
}

export function isSettlementBusinessDay(date: Date, calendar: SettlementCalendar): boolean {
  if (calendar === "BR") return isBrazilBusinessDay(date);
  if (isWeekend(date)) return false;
  if (calendar === "KR") return !koreanHolidaysOfYear(date.getUTCFullYear()).has(dateKey(date));
  if (calendar === "US") return !usHolidaysOfYear(date.getUTCFullYear()).has(dateKey(date));
  return true;
}

/**
 * start에서 영업일 days일 뒤. days=0이면 start가 휴장일일 때 다음 영업일로만
 * 옮긴다(브라질 D+0 관례).
 */
export function addSettlementBusinessDays(
  start: Date,
  days: number,
  calendar: SettlementCalendar
): Date {
  let date = new Date(start);
  if (days <= 0) {
    while (!isSettlementBusinessDay(date, calendar)) date = addDays(date, 1);
    return date;
  }
  let remaining = days;
  while (remaining > 0) {
    date = addDays(date, 1);
    if (isSettlementBusinessDay(date, calendar)) remaining--;
  }
  return date;
}

/**
 * 시장 관행 결제일수(T+n). 미국 채권은 2024-05-28부터 T+1(SEC Rule 15c6-1),
 * 브라질 국채는 D+0, 그 외(한국 등)는 T+2.
 */
export function getDefaultSettlementDays(
  calcBasis: CalcBasis | undefined,
  tradeCurrency: string | undefined
): number {
  const calendar = getSettlementCalendar(calcBasis, tradeCurrency);
  if (calendar === "BR") return 0;
  if (calendar === "US") return 1;
  return 2;
}

/** 화면 입력값("" = 자동)을 실제 결제일수로 환산. 0~30 밖이면 자동값. */
export function resolveSettlementDays(
  override: string | undefined,
  calcBasis: CalcBasis | undefined,
  tradeCurrency: string | undefined
): number {
  const trimmed = (override ?? "").trim();
  if (trimmed !== "" && /^\d{1,2}$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n >= 0 && n <= 30) return n;
  }
  return getDefaultSettlementDays(calcBasis, tradeCurrency);
}
