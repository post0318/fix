import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { koKR } from "@clerk/localizations";
import { AppAuthProvider } from "@/components/auth/AppAuth";
import { allowedEmailDomains, resolveAuthState } from "@/lib/server/appAuth";
import "./globals.css";

export const metadata: Metadata = {
  title: "채권세상",
  description: "채권정보만 입력하면 현금흐름을 보여주는 서비스",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Clerk 키가 없거나 오프라인 정적 export(서버가 없다)면 인증 없이 렌더 — 출력·업로드는
  // 잠긴 채로 남는다.
  const clerkEnabled =
    process.env.STATIC_EXPORT !== "1" && !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  // 인증 상태를 서버 렌더링에서 미리 판정해 내려준다(화면이 /api/auth/me 를 다시 부르지 않게).
  const initialAuth = clerkEnabled ? await resolveAuthState() : null;

  const body = (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <AppAuthProvider
          enabled={clerkEnabled}
          initial={initialAuth}
          allowedDomains={allowedEmailDomains()}
        >
          {children}
        </AppAuthProvider>
      </body>
    </html>
  );

  if (!clerkEnabled) return body;
  return (
    <ClerkProvider
      localization={koKR}
      // 로그인 팝업의 "가입" 링크 → 우리 가입 신청 폼(회사 이메일 검사)으로
      waitlistUrl="/?signup=1"
      afterSignOutUrl="/"
    >
      {body}
    </ClerkProvider>
  );
}
