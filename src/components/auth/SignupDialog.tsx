"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { isAllowedEmail, useAppAuth } from "@/components/auth/AppAuth";

interface SignupDialogProps {
  open: boolean;
  onClose: () => void;
  /** 가입 가능한 회사 이메일 도메인 (사전 검사용) */
  allowedDomains: string[];
}

/**
 * 가입 신청 팝업. 회사 이메일만 받아 Clerk 대기자 명단에 올린다. 관리자가
 * 「승인 관리」에서 승인하면 신청자에게 초대 메일(비밀번호 설정)이 간다.
 */
export function SignupDialog({ open, onClose, allowedDomains }: SignupDialogProps) {
  const auth = useAppAuth();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const domainsLabel = allowedDomains.map((d) => `@${d}`).join(", ");

  // 열릴 때 입력칸 포커스, Esc 로 닫기
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const addr = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      setError("이메일 형식이 올바르지 않습니다.");
      return;
    }
    if (!isAllowedEmail(addr, allowedDomains)) {
      setError(`회사 이메일(${domainsLabel})만 신청할 수 있습니다.`);
      return;
    }
    setBusy(true);
    try {
      await auth.joinWaitlist(addr);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "가입 신청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    onClose();
    // 다음에 열 때 초기 상태로
    setTimeout(() => {
      setDone(false);
      setError(null);
      setEmail("");
    }, 0);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="signup-title"
        className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 text-sm text-zinc-800 shadow-xl dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
      >
        {done ? (
          <>
            <p id="signup-title" className="font-medium">가입 신청이 접수되었습니다.</p>
            <p className="mt-1 text-xs text-zinc-500">
              관리자가 승인하면 {email} 로 안내 메일이 갑니다. 메일의 안내대로 비밀번호를
              만든 뒤 로그인하세요.
            </p>
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={close} className={btnPrimary}>
                확인
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-2">
            <p id="signup-title" className="font-medium">가입 신청</p>
            <p className="text-xs leading-relaxed text-zinc-500">
              회사 이메일({domainsLabel})만 가능하며 관리자 승인이 필요합니다.
              <br />
              상품운용팀 소속이 아니면 가입이 불가합니다.
            </p>
            <input
              ref={inputRef}
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={`이름@${allowedDomains[0] ?? "example.com"}`}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              required
            />
            {error && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={close} className={btnSecondary}>
                취소
              </button>
              <button type="submit" disabled={busy} className={btnPrimary}>
                {busy ? "신청 중…" : "신청"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

const btnPrimary =
  "inline-flex items-center rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const btnSecondary =
  "inline-flex items-center rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800";
