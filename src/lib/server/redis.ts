import { Redis } from "@upstash/redis";

/** Upstash Redis(Vercel Marketplace 연동, KV_REST_API_*)가 설정되어 있으면 클라이언트를,
 *  아니면(로컬 개발 등) null을 반환해 호출부가 조용히 폴백할 수 있게 한다. */
export function getRedis(): Redis | null {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try {
    return Redis.fromEnv();
  } catch {
    return null;
  }
}

/** 마지막 정상값 보관 기간 — 원본이 며칠 연속 실패해도 화면이 비지 않게 */
const LAST_GOOD_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface WithLastGoodResult<T> {
  value: T;
  /** 원본 대신 저장본을 돌려줬으면 그 저장 시각(ISO), 원본이면 null */
  staleSince: string | null;
}

/**
 * 원본 조회(fetcher)가 성공하면 그 값을 `${key}:last` 에 30일 보관하고 돌려준다.
 * 원본이 실패하거나 쓸 수 없는 값(isUsable=false, 예: 빈 목록)을 주면 보관해 둔
 * 마지막 정상값을 staleSince 와 함께 돌려준다(2026-10-14 — SEC·프랑크푸르트 등 외부
 * 서버가 느리거나 503 을 줄 때 화면이 오류로 비지 않게). 저장본도 없으면 원래 오류.
 */
export async function withLastGood<T>(
  key: string,
  fetcher: () => Promise<T>,
  isUsable: (value: T) => boolean = () => true
): Promise<WithLastGoodResult<T>> {
  const redis = getRedis();
  const lastKey = `${key}:last`;
  let failure: unknown;
  try {
    const value = await fetcher();
    if (isUsable(value)) {
      if (redis) {
        await redis
          .set(lastKey, { value, savedAt: new Date().toISOString() }, { ex: LAST_GOOD_TTL_SECONDS })
          .catch(() => {});
      }
      return { value, staleSince: null };
    }
    failure = new Error("원본 응답이 비어 있습니다.");
  } catch (error) {
    failure = error;
  }
  if (redis) {
    try {
      const last = await redis.get<{ value: T; savedAt: string }>(lastKey);
      if (last) return { value: last.value, staleSince: last.savedAt };
    } catch {
      // Redis 장애면 원래 오류를 낸다
    }
  }
  throw failure;
}
