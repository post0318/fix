import type { ReactNode } from "react";

/**
 * 오프라인 정적 export 빌드(STATIC_EXPORT=1) 전용 Clerk 대체 모듈. next.config.ts 가
 * 이 모드에서만 `@clerk/nextjs`·`@clerk/localizations` 를 이 파일로 바꿔 끼운다.
 * 실제 Clerk 에는 정적 export 가 지원하지 않는 서버 액션이 들어 있어서다.
 * 이 모드에서는 layout 이 인증을 끄므로(enabled=false) 아래 값은 호출되지 않는다.
 */
export const koKR = {};

export function ClerkProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useClerk() {
  return {
    openSignIn: () => {},
    openUserProfile: () => {},
    signOut: async () => {},
    joinWaitlist: async () => {},
  };
}

export function useUser() {
  return { isLoaded: true, isSignedIn: false, user: null };
}

export function UserButton(_props: { children?: ReactNode }) {
  void _props;
  return null;
}
UserButton.MenuItems = function MenuItems(_props: { children?: ReactNode }) {
  void _props;
  return null;
};
UserButton.Link = function Link(_props: Record<string, unknown>) {
  void _props;
  return null;
};

// @clerk/nextjs/server — 서버 코드가 import 만 하고 이 모드에서는 부르지 않는다.
export async function auth() {
  return { userId: null };
}
export async function currentUser() {
  return null;
}
export async function clerkClient() {
  throw new Error("오프라인 빌드에서는 사용할 수 없습니다.");
}
export function clerkMiddleware() {
  return () => undefined;
}
