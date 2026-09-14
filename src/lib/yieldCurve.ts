/**
 * 미 재무부 일별 국채 par yield curve 타입과 보간 — 서버(파싱·캐시)와
 * 클라이언트(make-whole 기준금리 자동채움)가 같은 구현을 쓴다. 이전엔 서버
 * `interpolateTreasuryRate`가 미사용(dead code)이고 클라이언트 `interpCurve`가
 * 같은 로직을 중복 구현하고 있었다(Fable 감사 #16/#17).
 */

/** 한 테너 점 (연 단위 만기, % 금리) */
export interface YieldCurvePoint {
  years: number;
  rate: number;
}

export interface TreasuryParYieldCurve {
  /** 곡선 기준일 (YYYY-MM-DD) */
  date: string;
  /** 만기(연) 오름차순 정렬 */
  points: YieldCurvePoint[];
}

/**
 * 곡선에서 임의 잔존만기(연)의 금리를 선형보간한다. 양끝은 클램프.
 * make-whole "Treasury Rate"(H.15 CMT를 잔존만기로 보간)의 근사치.
 */
export function interpolateTreasuryRate(
  curve: TreasuryParYieldCurve,
  years: number
): number | null {
  const pts = curve.points;
  if (!pts || pts.length === 0) return null;
  const last = pts[pts.length - 1];
  if (years <= pts[0].years) return pts[0].rate;
  if (years >= last.years) return last.rate;
  // 양끝 클램프를 통과했으면 years는 (pts[0], last) 사이라 상단 점이 반드시
  // 있다(i ≥ 1). 도달 불가능한 꼬리 return을 두지 않으려고 findIndex로 쓴다.
  const i = pts.findIndex((p) => years <= p.years);
  const lo = pts[i - 1];
  const hi = pts[i];
  const t = (years - lo.years) / (hi.years - lo.years);
  return lo.rate + t * (hi.rate - lo.rate);
}
