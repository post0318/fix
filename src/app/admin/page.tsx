import Link from "next/link";
import { AdminAccounts } from "@/components/admin/AdminAccounts";
import { requireAdmin } from "@/lib/server/appAuth";

export const dynamic = "force-dynamic";

/**
 * 계정 승인 관리 — 관리자(ADMIN_EMAILS)만. 마이페이지(계정 버튼) 메뉴의
 * 「승인 관리」에서 들어온다. 서버에서 먼저 권한을 확인해 관리자가 아니면
 * 화면 자체를 내려주지 않는다(API 도 같은 검사).
 */
export default async function AdminPage() {
  const who = await requireAdmin();

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-5 p-4 sm:p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          계정 승인 관리
        </h1>
        <Link
          href="/"
          className="text-sm text-zinc-600 hover:underline dark:text-zinc-400"
        >
          ← 글로벌 채권정보
        </Link>
      </header>

      {who.ok ? (
        <AdminAccounts />
      ) : (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {who.status === 401
            ? "로그인이 필요합니다. 첫 화면에서 로그인한 뒤 계정 버튼 → 승인 관리로 들어오세요."
            : who.error}
        </p>
      )}
    </div>
  );
}
