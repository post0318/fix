# 글로벌 채권정보

## 프로젝트 개요

채권정보를 입력하면 현금흐름과 수익률을 보여 주는 서비스. 종목 검색(글로벌·미국·한국),
엑셀 업로드, 콜(Par Call·Make-Whole) 시나리오를 지원한다.

## 기술스택

- Next.js 16 (app router), Tailwind CSS
- Upstash Redis (외부 원본 캐시 `withLastGood`, 업로드 채권 보관)
- Clerk (로그인·가입 대기자 승인) — brazil 프로젝트와 같은 Clerk 앱의 키를 쓴다
- Vercel 배포. `main`에 병합되면 운영이 다시 뜬다

## 코드규칙

- TypeScript 사용
- 컴포넌트는 src/components/ 아래에 작성
- 환경변수는 .env.local에 저장 (절대 커밋하지 않음)
- 모바일 반응형 디자인

## 로그인과 권한

- 업로드·출력은 승인 계정(허용 도메인 `ALLOWED_EMAIL_DOMAINS`, 기본 hanwha.com, 또는
  `ADMIN_EMAILS`)으로 로그인했을 때만 보인다. 비로그인은 현금흐름표에 워터마크와
  복사·인쇄 차단이 걸린다(`CashFlowGuard`).
- 서버 잠금은 `requireTradingUser()` / `requireAdmin()` (src/lib/server/appAuth.ts).
  Clerk 키가 없으면 인증이 꺼지고 업로드·출력은 잠긴 채 남는다.
- 업로드한 채권은 Redis 해시 `uploaded-bonds:v1`에 보관하고 조회는 누구나 한다.
  삭제는 올린 사람 본인 또는 관리자만. 목록에는 올린 사람 이메일을 내려 주지 않는다.
- `CRON_SECRET`이 없으면 `/api/cron/*`은 거부한다.

## 오프라인 배포

`npm run build:offline` / `build:single`은 서버(api)가 없는 정적 export다. 이 모드에서는
인증을 끄므로 업로드·출력이 잠긴다.
