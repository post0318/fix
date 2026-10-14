# 글로벌 채권정보

채권정보를 입력하면 현금흐름과 수익률을 보여 주는 Next.js 서비스. 프로젝트 규칙은
[claude.md](claude.md), 화면 규칙은 [PRD.md](PRD.md).

```bash
npm install
npm run dev     # http://localhost:3000
npm run build
npm run lint
```

환경변수는 `.env.local`에 둔다(커밋 금지): `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
`CLERK_SECRET_KEY`, `ADMIN_EMAILS`, `ALLOWED_EMAIL_DOMAINS`, `KV_REST_API_URL`,
`KV_REST_API_TOKEN`, `CRON_SECRET`, `SEC_USER_AGENT`, `DATA_GO_KR_BOND_SERVICE_KEY`.
