"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { InitialAuthState } from "@/lib/server/appAuth";
import { useClerk, useUser } from "@clerk/nextjs";

/**
 * 앱 인증 컨텍스트. Clerk 훅은 ClerkProvider 밖에서 부르면 예외가 나므로,
 * Clerk 키가 없는 환경(로컬 초기 상태)에서는 "비활성" 값을 대신 제공한다.
 * 화면 컴포넌트는 이 훅만 쓰고 Clerk 를 직접 참조하지 않는다.
 */
export interface AppAuth {
  /** Clerk 키가 설정되어 인증을 쓸 수 있는가 */
  enabled: boolean;
  /** Clerk 초기화 완료 여부 (false 면 아직 모름) */
  isLoaded: boolean;
  isSignedIn: boolean;
  /** 로그인한 계정의 대표 이메일 */
  email: string | null;
  /**
   * 출력·업로드 허용 여부 — 서버(/api/auth/me)가 회사 도메인 또는 관리자
   * 목록으로 판단. null 이면 아직 확인 전.
   */
  allowed: boolean | null;
  /** 관리자(ADMIN_EMAILS) 여부 — 계정 메뉴에 「승인 관리」 표시 */
  isAdmin: boolean;
  /** 서버가 거부한 이유(허용 안 될 때) */
  deniedReason: string | null;
  /** 가입 가능한 회사 이메일 도메인 (가입 신청 폼의 사전 검사용) */
  allowedDomains: string[];
  /** 로그인 팝업 열기 */
  openSignIn: () => void;
  /** 내 계정 팝업(비밀번호 변경 등) 열기 */
  openProfile: () => void;
  signOut: () => Promise<void>;
  /** 대기자 가입 신청 (승인 후 로그인 가능). 실패 시 메시지를 던진다. */
  joinWaitlist: (emailAddress: string) => Promise<void>;
}

const DISABLED: AppAuth = {
  enabled: false,
  isLoaded: true,
  isSignedIn: false,
  email: null,
  allowed: false,
  isAdmin: false,
  deniedReason: null,
  allowedDomains: [],
  openSignIn: () => {},
  openProfile: () => {},
  signOut: async () => {},
  joinWaitlist: async () => {
    throw new Error("인증 서비스가 설정되지 않았습니다.");
  },
};

const Ctx = createContext<AppAuth>(DISABLED);

function ClerkBridge({
  initial,
  allowedDomains,
  children,
}: {
  initial: InitialAuthState | null;
  allowedDomains: string[];
  children: ReactNode;
}) {
  const clerk = useClerk();
  const { isLoaded, isSignedIn, user } = useUser();
  // 서버(layout)가 이미 판정해 내려준 값으로 시작한다 — 첫 화면에서 /api/auth/me
  // 왕복이 사라진다. 로그인·로그아웃으로 사용자가 바뀔 때만 다시 묻는다.
  const [verdict, setVerdict] = useState<{
    allowed: boolean;
    admin: boolean;
    reason: string | null;
  } | null>(
    initial
      ? { allowed: initial.allowed, admin: initial.admin, reason: initial.reason }
      : null
  );
  const lastCheckedRef = useRef<string | null>(initial?.userId ?? null);

  useEffect(() => {
    if (!isLoaded) return;
    const uid = isSignedIn ? (user?.id ?? null) : null;
    // 서버가 본 사용자와 같으면 다시 물을 필요가 없다.
    if (lastCheckedRef.current === uid) return;
    lastCheckedRef.current = uid;
    // 로그아웃이면 아래 파생값(allowed)이 false 가 되므로 추가 조회 불필요.
    if (!uid) return;
    let cancelled = false;
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d: { allowed?: boolean; admin?: boolean; reason?: string }) => {
        if (!cancelled)
          setVerdict({ allowed: d.allowed === true, admin: d.admin === true, reason: d.reason ?? null });
      })
      .catch(() => {
        if (!cancelled)
          setVerdict({ allowed: false, admin: false, reason: "허용 여부를 확인하지 못했습니다." });
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, user?.id]);

  const value: AppAuth = {
    enabled: true,
    isLoaded,
    isSignedIn: !!isSignedIn,
    email:
      user?.primaryEmailAddress?.emailAddress ??
      user?.emailAddresses?.[0]?.emailAddress ??
      null,
    allowed: !isSignedIn ? false : verdict ? verdict.allowed : null,
    isAdmin: !!isSignedIn && verdict?.admin === true,
    deniedReason: verdict?.reason ?? null,
    allowedDomains,
    openSignIn: () => clerk.openSignIn({}),
    openProfile: () => clerk.openUserProfile({}),
    signOut: () => clerk.signOut(),
    joinWaitlist: async (emailAddress) => {
      try {
        await clerk.joinWaitlist({ emailAddress });
      } catch (e) {
        const msg =
          (e as { errors?: { longMessage?: string; message?: string }[] })?.errors?.[0]
            ?.longMessage ??
          (e as { errors?: { message?: string }[] })?.errors?.[0]?.message ??
          (e instanceof Error ? e.message : "가입 신청에 실패했습니다.");
        throw new Error(msg);
      }
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function AppAuthProvider({
  enabled,
  initial = null,
  allowedDomains = [],
  children,
}: {
  enabled: boolean;
  allowedDomains?: string[];
  /** 서버 렌더링 시점의 판정 (layout 에서 내려준다) */
  initial?: InitialAuthState | null;
  children: ReactNode;
}) {
  if (!enabled) return <Ctx.Provider value={DISABLED}>{children}</Ctx.Provider>;
  return <ClerkBridge initial={initial} allowedDomains={allowedDomains}>{children}</ClerkBridge>;
}

export function useAppAuth(): AppAuth {
  return useContext(Ctx);
}

/** 가입 신청 폼의 사전 안내용 도메인 검사. 접근 허용 판단은 서버(/api/auth/me)가 한다. */
export function isAllowedEmail(email: string, allowedDomains: string[]): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return allowedDomains.some((d) => domain === d.toLowerCase());
}
