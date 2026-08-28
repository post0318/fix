/**
 * 브라질 국채(NTN-F 등)의 Business/252 일수계산방식에 필요한 브라질 영업일 계산.
 * ANBIMA/B3가 쓰는 국경일 캘린더(고정일 + 부활절 기준 이동공휴일)를 구현한다.
 * 카니발(월/화)·성금요일·성체축일(corpus christi)은 부활절 기준으로 계산하고,
 * 나머지는 매년 같은 날짜의 고정 국경일이다.
 */

/** 그레고리력 부활절(춘분 후 첫 만월 다음 일요일) 계산 - Anonymous Gregorian algorithm */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const monthDay = h + l - 7 * m + 114;
  const month = Math.floor(monthDay / 31); // 3 = March, 4 = April
  const day = (monthDay % 31) + 1;
  return new Date(year, month - 1, day);
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

const holidayCache = new Map<number, Set<string>>();

function brazilHolidaysOfYear(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const easter = easterSunday(year);
  const dates = [
    new Date(year, 0, 1), // 신정
    addDays(easter, -48), // 카니발 월요일
    addDays(easter, -47), // 카니발 화요일
    addDays(easter, -2), // 성금요일
    new Date(year, 3, 21), // 치라덴치스의 날
    new Date(year, 4, 1), // 노동절
    addDays(easter, 60), // 성체축일(Corpus Christi)
    new Date(year, 8, 7), // 독립기념일
    new Date(year, 9, 12), // 아파레시다 성모의 날
    new Date(year, 10, 2), // 위령의 날
    new Date(year, 10, 15), // 공화국 선포일
    new Date(year, 11, 25), // 크리스마스
  ];
  if (year >= 2024) {
    dates.push(new Date(year, 10, 20)); // 흑인 의식의 날(2024년부터 국경일, Lei 14.759/2023)
  }

  const set = new Set(dates.map(dateKey));
  holidayCache.set(year, set);
  return set;
}

function isBrazilHoliday(date: Date): boolean {
  return brazilHolidaysOfYear(date.getFullYear()).has(dateKey(date));
}

export function isBrazilBusinessDay(date: Date): boolean {
  const dow = date.getDay();
  return dow !== 0 && dow !== 6 && !isBrazilHoliday(date);
}

/**
 * start(제외)부터 end(포함)까지의 브라질 영업일수를 센다. start > end면 음수를
 * 반환한다(다른 yearFrac 구현들과의 부호 규칙 일치).
 */
export function brazilBusinessDaysBetween(start: Date, end: Date): number {
  let s = start;
  let e = end;
  let sign = 1;
  if (s > e) {
    [s, e] = [e, s];
    sign = -1;
  }

  let count = 0;
  const cursor = addDays(s, 1);
  while (cursor <= e) {
    if (isBrazilBusinessDay(cursor)) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return sign * count;
}
