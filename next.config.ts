import type { NextConfig } from "next";

/**
 * 기본(Vercel 배포용)은 서버 포함 일반 빌드다. 영업점 오프라인 zip/bat
 * 배포용 정적 export는 STATIC_EXPORT=1로만 활성화한다(scripts/build-offline.mjs 참고) —
 * 서버가 필요한 기능(예: 종목검색 API route)은 이 모드에서 빌드 대상에서 제외해야 한다.
 */
const isStaticExport = process.env.STATIC_EXPORT === "1";

// 보안 헤더(2026-10-14 보안 점검, brazil 프로젝트와 같은 값). 다른 사이트가 iframe 으로
// 끼워 넣지 못하게, 외부 링크로 나갈 때 주소가 전달되지 않게, MIME 스니핑 차단.
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // 검색엔진 제외 — 페이지 메타(noindex)가 붙지 않는 API 응답·파일까지 헤더로 알린다.
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = isStaticExport
  ? {
      output: "export",
      assetPrefix: ".",
      // 정적 export 는 서버 액션을 지원하지 않는데 Clerk 에 들어 있다 → 대체 모듈로 바꿔 끼운다.
      turbopack: {
        resolveAlias: {
          "@clerk/nextjs": "./src/lib/offline/clerk-stub.tsx",
          "@clerk/nextjs/server": "./src/lib/offline/clerk-stub.tsx",
          "@clerk/localizations": "./src/lib/offline/clerk-stub.tsx",
        },
      },
    }
  : {
      poweredByHeader: false,
      async headers() {
        return [{ source: "/(.*)", headers: securityHeaders }];
      },
    };

export default nextConfig;
