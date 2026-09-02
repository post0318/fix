import crypto from "crypto";
import { getRedis } from "@/lib/server/redis";
import { impliedYieldFromPrice } from "@/lib/bondPricing";
import type { CouponFrequency } from "@/types/bondLayout";

// boerse-frankfurt.de가 live.deutsche-boerse.com으로 리브랜딩/이전되면서 옛
// 도메인은 리다이렉트만 거쳐가는데(약 2~3초 추가 소요), 홈페이지+메인 JS
// 번들(2MB대)을 매번 새로 받다 보니 salt 하나 얻는 데만 8초 안팎이 걸려
// Vercel 함수 타임아웃을 넘기곤 했다. 새 도메인으로 바로 요청해 리다이렉트
// 구간을 줄이고, 아래 Redis 캐시로 콜드스타트마다 다시 받지 않게 한다.
const HOME_URL = "https://live.deutsche-boerse.com/";
const DATA_BASE = "https://api.boerse-frankfurt.de/v1/data/";
const SEARCH_BASE = "https://api.boerse-frankfurt.de/v1/search/";
/** 같은 서버리스 인스턴스 안 메모리 캐시 신선도. 짧게 둬도 아래 Redis가 대부분 받아준다 */
const SALT_TTL_MS = 15 * 60 * 1000;
/** Redis에 salt를 얼마나 오래 들고 있을지. 접속이 뜸해도(하루 1회 정도의
 *  Vercel Cron만 있어도) 콜드스타트 첫 요청이 8초짜리 홈페이지+JS 번들
 *  재요청을 떠안지 않도록 훨씬 길게 잡는다. salt가 실제로 바뀌어도
 *  withSaltRetry가 401/403에서 자동으로 다시 받으므로 안전하다. */
const REDIS_SALT_TTL_SECONDS = 24 * 60 * 60;
const REDIS_SALT_KEY = "bf-salt-v1";

let cachedSalt: { value: string; fetchedAt: number } | null = null;

const FETCH_TIMEOUT_MS = 8000;

/**
 * fetch()는 기본적으로 타임아웃이 없어, 상대 서버가(또는 그 앞단의 봇 차단
 * 장비가) 응답 없이 연결만 붙잡고 있으면 Vercel 함수 자체 제한(300초)까지
 * 그대로 걸려버린다(실제로 겪음: bond-detail 요청이 5분 만에야 504로 끝남).
 * 요청마다 짧게 끊어 빨리 실패하게 한다.
 */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 위 fetchWithTimeout은 fetch()가 응답 헤더를 받는 순간 끝난 것으로 보고
 * 타이머를 해제한다. 그런데 실제로 quote_box 엔드포인트에서 헤더는 빨리
 * 오고 본문(body) 스트림만 응답 없이 멈춰있는 경우를 실제로 겪었다(다른
 * 엔드포인트는 정상, quote_box만 멈춤 — 로그로 확인). fetch+본문 읽기 전체를
 * 별도로 다시 한번 시간제한 안에 가두어, 본문 단계에서 멈춰도 지정 시간
 * 안에는 반드시 빠져나오게 한다.
 */
async function withOverallTimeout<T>(
  run: () => Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 응답이 ${ms}ms 안에 오지 않았습니다.`)), ms);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function fetchSalt(): Promise<string> {
  const homeRes = await fetchWithTimeout(HOME_URL, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!homeRes.ok) throw new Error("boerse-frankfurt 홈페이지에 접속할 수 없습니다.");
  const homeHtml = await homeRes.text();
  const fileMatch = homeHtml.match(/src="(main\.[\w-]*\.js)"/);
  if (!fileMatch) throw new Error("메인 스크립트 파일을 찾을 수 없습니다.");
  const jsRes = await fetchWithTimeout(HOME_URL + fileMatch[1], {
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!jsRes.ok) throw new Error("메인 스크립트를 불러올 수 없습니다.");
  const jsText = await jsRes.text();
  const saltMatch = jsText.match(/salt:"(\w*)"/);
  if (!saltMatch) throw new Error("salt 값을 찾을 수 없습니다.");
  return saltMatch[1];
}

/**
 * salt는 메모리 캐시(같은 서버리스 인스턴스 안)뿐 아니라 Upstash Redis에도
 * 캐시해, 콜드스타트로 인스턴스가 새로 뜰 때마다(=대부분의 요청) 2MB대 JS
 * 번들을 다시 받는 8초짜리 지연이 반복되지 않게 한다(브라질채권검색 캐시와
 * 동일한 이유).
 */
export async function getSalt(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedSalt && Date.now() - cachedSalt.fetchedAt < SALT_TTL_MS) {
    return cachedSalt.value;
  }

  const redis = getRedis();
  if (!forceRefresh && redis) {
    try {
      const cached = await redis.get<string>(REDIS_SALT_KEY);
      if (cached) {
        cachedSalt = { value: cached, fetchedAt: Date.now() };
        return cached;
      }
    } catch {
      // Redis 조회 실패는 무시하고 원본에서 새로 받는다.
    }
  }

  const value = await fetchSalt();
  cachedSalt = { value, fetchedAt: Date.now() };
  if (redis) {
    redis.set(REDIS_SALT_KEY, value, { ex: REDIS_SALT_TTL_SECONDS }).catch(() => {});
  }
  return value;
}

function buildSecurityHeaders(url: string, salt: string): Record<string, string> {
  const now = new Date();
  const clientDate = now.toISOString();
  const traceId = crypto
    .createHash("md5")
    .update(clientDate + url + salt)
    .digest("hex");
  const pad = (n: number) => String(n).padStart(2, "0");
  const xSecurityBase = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const xSecurity = crypto.createHash("md5").update(xSecurityBase).digest("hex");
  return {
    "client-date": clientDate,
    "x-client-traceid": traceId,
    "x-security": xSecurity,
  };
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function withSaltRetry<T>(
  run: (salt: string) => Promise<{ res: Response; data: T }>,
  label: string,
  overallTimeoutMs: number = FETCH_TIMEOUT_MS * 2
): Promise<T> {
  return withOverallTimeout(
    async () => {
      let salt = await getSalt();
      let { res, data } = await run(salt);
      if (res.status === 401 || res.status === 403) {
        salt = await getSalt(true);
        ({ res, data } = await run(salt));
      }
      if (!res.ok) {
        throw new Error(`boerse-frankfurt 요청 실패 (${res.status})`);
      }
      return data;
    },
    overallTimeoutMs,
    label
  );
}

async function dataRequest(
  fn: string,
  params: Record<string, string>,
  overallTimeoutMs?: number
): Promise<Record<string, unknown> | null> {
  return withSaltRetry(
    async (salt) => {
      const url = `${DATA_BASE}${fn}?${new URLSearchParams(params)}`;
      const res = await fetchWithTimeout(url, {
        headers: {
          ...buildSecurityHeaders(url, salt),
          accept: "application/json, text/plain, */*",
        },
      });
      return { res, data: (await safeJson(res)) as Record<string, unknown> | null };
    },
    fn,
    overallTimeoutMs
  );
}

async function searchRequest(
  fn: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  return withSaltRetry(async (salt) => {
    const url = `${SEARCH_BASE}${fn}`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        ...buildSecurityHeaders(url, salt),
        accept: "application/json, text/plain, */*",
        "content-type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(body),
    });
    return { res, data: (await safeJson(res)) as Record<string, unknown> | null };
  }, fn);
}

async function searchGetRequest(
  fn: string,
  params: Record<string, string>
): Promise<Record<string, unknown> | null> {
  return withSaltRetry(async (salt) => {
    const url = `${SEARCH_BASE}${fn}?${new URLSearchParams(params)}`;
    const res = await fetchWithTimeout(url, {
      headers: {
        ...buildSecurityHeaders(url, salt),
        accept: "application/json, text/plain, */*",
      },
    });
    return { res, data: (await safeJson(res)) as Record<string, unknown> | null };
  }, fn);
}

/** bond_search_criteria_data의 발행자(issuer) 전체 목록 (약 4,600여개) */
export async function getIssuers(): Promise<string[]> {
  const data = await searchGetRequest("bond_search_criteria_data", { lang: "de" });
  const issuers = data?.issuers;
  return Array.isArray(issuers) ? (issuers as string[]) : [];
}

export interface BondSearchItem {
  isin: string;
  name: string;
  coupon: number | null;
  currency: string | null;
  slug: string | null;
}

/**
 * 특정 발행자의 채권 목록 (라벨/쿠폰/통화/슬러그). limit을 200에서 1000으로
 * 올렸다 — 발행 종목이 많은 발행자(예: 독일 국채 recordsTotal=225건)는
 * 200으로 잘려 일부가 누락됐음을 확인.
 */
export async function searchBondsByIssuer(issuer: string): Promise<BondSearchItem[]> {
  const data = await searchRequest("bond_search", {
    issuers: [issuer],
    lang: "de",
    offset: 0,
    limit: 1000,
    sorting: "NAME",
    sortOrder: "ASC",
  });
  const items = data?.data;
  if (!Array.isArray(items)) return [];

  return items.map((item) => {
    const record = item as Record<string, unknown>;
    const name = record.name as { originalValue?: string } | undefined;
    const keyData = record.keyData as
      | { coupon?: number; currency?: { originalValue?: string } }
      | undefined;
    return {
      isin: String(record.isin ?? ""),
      name: name?.originalValue ?? String(record.isin ?? ""),
      coupon: typeof keyData?.coupon === "number" ? keyData.coupon : null,
      currency: keyData?.currency?.originalValue ?? null,
      slug: typeof record.slug === "string" ? record.slug : null,
    };
  });
}

export interface BondDetail {
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

/**
 * master_data_bond의 interestPaymentPeriod(지급주기) 필드는 국채/회사채
 * 가리지 않고 거의 항상 null이라(실제 확인) 못 쓴다. 대신 같은 응답에
 * firstAnnualPayDate(첫 이자지급일)는 채워지는 경우가 많다 — 발행일부터
 * 첫 지급일까지의 개월수를 재면 지급주기를 역산할 수 있다(실제 검증:
 * Microsoft 2027 Notes 2017-02-06→2017-08-06=6개월, Alphabet 2054 Notes
 * 2025-05-06→2026-05-06=12개월 — 둘 다 SEC 원문 확인값과 정확히 일치).
 * 표준 주기(3/6/12개월)에서 ±1~2개월 벗어나도 그쪽으로 묶는다(영업일
 * 조정 등으로 정확히 딱 떨어지지 않을 수 있어서).
 */
function frequencyFromFirstPayGap(
  issueDate: string | null,
  firstAnnualPayDate: string | null
): number | null {
  if (!issueDate || !firstAnnualPayDate) return null;
  const im = issueDate.match(/^(\d{4})-(\d{2})-\d{2}$/);
  const pm = firstAnnualPayDate.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!im || !pm) return null;
  const diff =
    (Number(pm[1]) - Number(im[1])) * 12 + (Number(pm[2]) - Number(im[2]));
  if (diff >= 2 && diff <= 4) return 3;
  if (diff >= 5 && diff <= 8) return 6;
  if (diff >= 9 && diff <= 15) return 12;
  return null;
}

export interface BondQuote {
  bidYield: number | null;
  askYield: number | null;
  lastPriceYield: number | null;
}

/**
 * 실제 사이트 JS 번들(main.*.js)에서 확인한 진짜 엔드포인트는 quote_box가
 * 아니라 price_information이었다(quote_box는 애초에 검증된 적 없는 추측값 —
 * 이전 패치 주석에도 명시돼 있었다). 게다가 이 엔드포인트는 한 번 응답하고
 * 끝나는 일반 REST가 아니라 Server-Sent Events(SSE) 스트림이라, 응답 헤더는
 * 바로 오지만 body는 실시간 시세가 나올 때마다 계속 이어진다. res.text()로
 * 전체 body가 끝나기를 기다리면 스트림이 끝나지 않으니 영원히 대기하게
 * 되는데, 이게 Vercel에서 상세조회가 응답 없이 멈추던 진짜 원인이었다
 * (개인 PC의 curl 테스트에서 "빨리 성공"한 것처럼 보인 것도 --max-time으로
 * 강제로 끊어서 첫 이벤트만 받혔기 때문— 사실은 같은 문제였다). 첫
 * 이벤트(data: 한 줄)만 읽고 바로 스트림을 끊는다.
 *
 * Accept 헤더는 다른 요청들과 같은 값(application/json, text/plain 등 포함)을
 * 쓰면 406이 난다 — 이 엔드포인트는 모든 타입 허용(와일드카드)을 요구한다(직접 확인).
 */
async function fetchFirstSseEvent(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { ...headers, accept: "*/*" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    try {
      // 첫 청크가 이벤트 타입 선언이나 keep-alive 주석 줄만 담고 있을 수 있어
      // (실제로 겪음: 한 번만 읽으면 data: 줄을 못 찾는 경우가 있었다), 실제
      // "data:" 줄이 나올 때까지 여러 청크를 이어붙여가며 읽는다. 타임아웃은
      // 바깥의 AbortController가 그대로 지켜준다.
      let buffer = "";
      const decoder = new TextDecoder();
      for (let i = 0; i < 20; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) buffer += decoder.decode(value, { stream: true });
        const match = buffer.match(/data:\s*(\{.*\})/);
        if (match) {
          try {
            return JSON.parse(match[1]) as Record<string, unknown>;
          } catch {
            return null;
          }
        }
      }
      return null;
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const PRICE_FETCH_TIMEOUT_MS = 4000;

/**
 * ISIN+MIC로 현재가(price_information, lastPrice/기준시각)를 조회한다. 이
 * 엔드포인트는 가격만 주고 수익률(yield)은 직접 주지 않는다(실제 확인:
 * lastPrice 필드만 있고 yield류 필드 없음). 실시간 스트림 특성상 언제든
 * 다시 멈출 수 있어 짧은 시간 안에 포기하도록 타임아웃을 짧게(4초) 둔다 —
 * 응답 없음이 곧 "이 종목은 못 채운다"는 뜻이라 오래 기다려도 얻는 게 없다.
 */
async function getLastPrice(
  isin: string,
  mic: string
): Promise<{ price: number; asOf: string | null } | null> {
  const salt = await getSalt().catch(() => null);
  if (!salt) return null;

  const url = `${DATA_BASE}price_information?${new URLSearchParams({ isin, mic })}`;
  const data = await fetchFirstSseEvent(
    url,
    buildSecurityHeaders(url, salt),
    PRICE_FETCH_TIMEOUT_MS
  );
  const price = data?.lastPrice;
  if (typeof price !== "number") return null;
  const asOf = typeof data?.timestampLastPrice === "string" ? data.timestampLastPrice : null;
  return { price, asOf };
}

function frequencyFromMonths(m: number | null | undefined): CouponFrequency {
  return m === 3 ? "3개월" : m === 12 ? "12개월" : "6개월";
}

/**
 * ISIN+MIC로 현재가를 조회해 만기수익률을 추정한다. boerse-frankfurt API는
 * 가격(lastPrice, %표시 clean)만 주고 수익률·날짜계산기준은 안 준다. 날짜계산
 * 기준은 확인할 방법이 없어 미국 30/360으로 가정하고(`impliedYieldFromPrice`가
 * basis 인자를 넘기지 않는다), 이자지급주기는 알 수 있으면(`freqMonths`) 그 값,
 * 없으면 6개월로 가정해 `impliedYieldFromPrice`로 역산한다. 실제 기준이 다르면
 * 오차가 있는 추정치다. 결과가 −5%~+50% 밖이면(단위표시 호가·파싱 오류 등)
 * null. bidYield/askYield는 대응 데이터가 없어 항상 null이다.
 */
export async function getBondQuote(
  isin: string,
  mic: string,
  couponRate: number | null,
  maturityDate: string | null,
  freqMonths?: number | null
): Promise<BondQuote> {
  const result: BondQuote = { bidYield: null, askYield: null, lastPriceYield: null };

  const last = await getLastPrice(isin, mic);
  if (!last || couponRate === null || !maturityDate) return result;

  const maturity = new Date(maturityDate);
  const settlement = last.asOf ? new Date(last.asOf) : new Date();
  const yieldEstimate = impliedYieldFromPrice(
    settlement,
    maturity,
    couponRate / 100,
    last.price,
    100,
    frequencyFromMonths(freqMonths)
  );
  // sanity: 역산 결과가 상식 범위 밖이면(예: 가격이 단위표시라 100 기준이 아닐 때
  // -20% 같은 값이 나온다) 추정치로 쓰지 않는다.
  if (yieldEstimate !== null && yieldEstimate > -0.05 && yieldEstimate < 0.5) {
    result.lastPriceYield = Math.round(yieldEstimate * 100000) / 1000;
  }

  return result;
}

/**
 * ISIN으로 boerse-frankfurt 상장 여부(거래소 MIC)만 확인한 뒤, 표면이율/
 * 만기일은 호출부가 이미 알고 있는 값을 그대로 써서 현재가 기반 수익률을
 * 추정한다. master_data_bond의 cupon 필드가 국채는 비어있는 경우가 있어
 * (실제 확인: 미국국채 CUSIP 912810US5 -> ISIN US912810US59, master_data_
 * bond가 cupon:null 반환) getBondDetail처럼 그 필드에 의존하면 안 된다.
 * 미국채권검색(SEC EDGAR 회사채는 이미 ISIN을 갖고 있고, 국채는 CUSIP에서
 * 표준 규칙으로 ISIN을 계산해 넘김)에서 매수금리를 채우는 데 쓴다.
 */
export async function getYieldEstimateByIsin(
  isin: string,
  couponRate: number,
  maturityDate: string,
  freqMonths?: number | null
): Promise<number | null> {
  const info = await dataRequest("instrument_information", { isin });
  const mics = info?.mics;
  const mic =
    (typeof info?.defaultMic === "string" ? info.defaultMic : undefined) ??
    (Array.isArray(mics) && typeof mics[0] === "string" ? mics[0] : undefined);
  if (!mic) return null;

  const quote = await getBondQuote(isin, mic, couponRate, maturityDate, freqMonths);
  return quote.lastPriceYield;
}

/** ISIN으로 발행일/만기일/표면이율/거래통화(+상세페이지 slug)와 매수/매도 수익률을 조회한다 */
export async function getBondDetail(isin: string): Promise<BondDetail> {
  const info = await dataRequest("instrument_information", { isin });
  const mics = info?.mics;
  const mic =
    (typeof info?.defaultMic === "string" ? info.defaultMic : undefined) ??
    (Array.isArray(mics) && typeof mics[0] === "string" ? mics[0] : undefined);
  if (!mic) throw new Error("거래소(MIC) 정보를 찾을 수 없습니다.");

  const master = await dataRequest("master_data_bond", { isin, mic });
  const couponRate = typeof master?.cupon === "number" ? master.cupon : null;
  const maturityDate = typeof master?.maturity === "string" ? master.maturity : null;

  const issueDate = typeof master?.issueDate === "string" ? master.issueDate : null;
  const firstAnnualPayDate =
    typeof master?.firstAnnualPayDate === "string" ? master.firstAnnualPayDate : null;
  // master로 실제 지급주기를 알 수 있으면 역산에 그 값을 쓴다(6개월 하드코딩 대신).
  const freqMonths = frequencyFromFirstPayGap(issueDate, firstAnnualPayDate);

  // 현재가 조회는 부가 정보라, 실패해도 나머지(발행일/만기일 등) 조회는
  // 살린다. price_information이 SSE 스트림이라는 걸 확인해 4초 안에 첫
  // 이벤트만 읽고 빠져나오도록 고쳐서 더 이상 상세조회 전체가 멈추지는
  // 않는다(getBondQuote 주석 참고). lastPriceYield는 날짜계산기준(30/360 가정)
  // 에 기반한 추정치다.
  const quote = await getBondQuote(
    isin,
    mic,
    couponRate,
    maturityDate,
    freqMonths
  ).catch((err) => {
    console.warn(`[boerseFrankfurt] price_information(${isin}) 조회 실패:`, err);
    return { bidYield: null, askYield: null, lastPriceYield: null } as BondQuote;
  });

  return {
    isin,
    issueDate,
    maturityDate,
    couponRate,
    currency: typeof master?.issueCurrency === "string" ? master.issueCurrency : null,
    slug: typeof info?.slug === "string" ? info.slug : null,
    bidYield: quote.bidYield,
    askYield: quote.askYield,
    lastPriceYield: quote.lastPriceYield,
    couponFrequencyMonths: freqMonths,
  };
}
