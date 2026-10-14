"use client";

import { useEffect } from "react";

/**
 * 현금흐름표 열람 제한 — brazil 프로젝트의 ClientViewGuard 와 같은 방식(오너 지시).
 *  - 인쇄 차단: `@media print` 에서 본문을 숨기고 안내문만 (globals.css 의
 *    `body.cf-guard` 규칙)
 *  - 현금흐름표 안에서만 우클릭·복사·잘라내기·드래그 차단 + 텍스트 선택 불가
 *    (입력 칸까지 막으면 입력 레이아웃을 못 쓰므로 표 영역으로 한정)
 *  - 표 위 워터마크 오버레이 (캡처는 웹에서 못 막으므로 추적·억제용)
 * ※ 스크린샷·사진 촬영은 OS/외부 기기 동작이라 웹에서 원천 차단 불가.
 */
export function CashFlowGuard() {
  useEffect(() => {
    document.body.classList.add("cf-guard");
    const block = (e: Event) => {
      const t = e.target;
      if (t instanceof Element && t.closest("[data-cf-table]")) e.preventDefault();
    };
    const events = ["contextmenu", "copy", "cut", "dragstart"] as const;
    events.forEach((ev) => document.addEventListener(ev, block));
    return () => {
      document.body.classList.remove("cf-guard");
      events.forEach((ev) => document.removeEventListener(ev, block));
    };
  }, []);

  return (
    <div className="cf-print-notice" aria-hidden="true">
      인쇄할 수 없습니다 — 사내 참고용 자료입니다.
    </div>
  );
}

/** 표 위에 깔리는 워터마크 타일(SVG data URI). */
export function cashFlowWatermarkStyle(issued: string): React.CSSProperties {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='360' height='220'>` +
    `<text x='14' y='130' transform='rotate(-27 180 110)' ` +
    `fill='rgba(120,122,132,0.16)' font-size='14' font-weight='600' ` +
    `font-family='system-ui,-apple-system,sans-serif'>` +
    `사내 참고용 · 무단 복제·배포 금지 · ${issued}</text></svg>`;
  return {
    backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`,
    backgroundRepeat: "repeat",
  };
}
