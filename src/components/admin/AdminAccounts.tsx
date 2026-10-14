"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminUser, AdminWaitlistEntry } from "@/app/api/admin/accounts/route";

type Data = { waitlist: AdminWaitlistEntry[]; users: AdminUser[]; me: string };

const STATUS_LABEL: Record<AdminWaitlistEntry["status"], string> = {
  pending: "승인 대기",
  invited: "승인됨 · 초대 메일 발송",
  completed: "가입 완료",
  rejected: "거절됨",
};

function fmt(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 계정 승인 관리 화면 (/admin). 관리자만 서버가 통과시킨다. */
export function AdminAccounts() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 목록 조회는 effect 안에서 promise 콜백으로만 setState (react-hooks 규칙).
  // 재조회는 reloadKey 를 올려서.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/accounts", { cache: "no-store" })
      .then(async (r) => {
        const d = (await r.json()) as Data & { error?: string };
        if (cancelled) return;
        if (!r.ok) {
          setError(d.error ?? `불러오기 실패 (HTTP ${r.status})`);
          return;
        }
        setError(null);
        setData(d);
      })
      .catch(() => {
        if (!cancelled) setError("네트워크 오류가 났습니다.");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const act = async (action: "invite" | "reject" | "ban" | "unban", id: string, label: string) => {
    if (busyId) return;
    setBusyId(id);
    setNotice(null);
    try {
      const r = await fetch("/api/admin/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setNotice(d.error ?? `실패 (HTTP ${r.status})`);
        return;
      }
      setNotice(`${label} 완료`);
      reload();
    } catch {
      setNotice("네트워크 오류가 났습니다.");
    } finally {
      setBusyId(null);
    }
  };

  if (error) {
    return (
      <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
        {error}
      </p>
    );
  }
  if (!data) return <p className="text-sm text-zinc-500">불러오는 중…</p>;

  const pending = data.waitlist.filter((e) => e.status === "pending");
  const others = data.waitlist.filter((e) => e.status !== "pending");

  return (
    <div className="flex flex-col gap-6">
      {notice && (
        <p className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          {notice}
        </p>
      )}

      <Section title={`승인 대기 (${pending.length})`}>
        {pending.length === 0 ? (
          <Empty>대기 중인 신청이 없습니다.</Empty>
        ) : (
          <Table head={["이메일", "신청일시", ""]}>
            {pending.map((e) => (
              <tr key={e.id}>
                <Td>{e.email}</Td>
                <Td muted>{fmt(e.createdAt)}</Td>
                <Td right>
                  <Btn primary disabled={busyId === e.id} onClick={() => act("invite", e.id, `${e.email} 승인`)}>
                    승인
                  </Btn>
                  <Btn disabled={busyId === e.id} onClick={() => act("reject", e.id, `${e.email} 거절`)}>
                    거절
                  </Btn>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-2 text-xs text-zinc-500">
          승인하면 신청자에게 초대 메일이 갑니다. 메일의 링크에서 비밀번호를 만들면 아래
          사용자 목록에 나타납니다.
        </p>
      </Section>

      <Section title={`사용자 (${data.users.length})`}>
        {data.users.length === 0 ? (
          <Empty>가입 완료한 사용자가 없습니다.</Empty>
        ) : (
          <Table head={["이메일", "가입일", "최근 로그인", "상태", ""]}>
            {data.users.map((u) => (
              <tr key={u.id}>
                <Td>
                  {u.email}
                  {u.email === data.me && (
                    <span className="ml-1.5 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                      나
                    </span>
                  )}
                </Td>
                <Td muted>{fmt(u.createdAt)}</Td>
                <Td muted>{fmt(u.lastSignInAt)}</Td>
                <Td>
                  {u.banned ? (
                    <span className="text-red-600 dark:text-red-400">차단됨</span>
                  ) : (
                    <span className="text-emerald-700 dark:text-emerald-400">정상</span>
                  )}
                </Td>
                <Td right>
                  {u.email !== data.me &&
                    (u.banned ? (
                      <Btn disabled={busyId === u.id} onClick={() => act("unban", u.id, `${u.email} 차단 해제`)}>
                        차단 해제
                      </Btn>
                    ) : (
                      <Btn danger disabled={busyId === u.id} onClick={() => act("ban", u.id, `${u.email} 차단`)}>
                        접근 차단
                      </Btn>
                    ))}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      {others.length > 0 && (
        <Section title={`처리된 신청 (${others.length})`}>
          <Table head={["이메일", "신청일시", "상태"]}>
            {others.map((e) => (
              <tr key={e.id}>
                <Td>{e.email}</Td>
                <Td muted>{fmt(e.createdAt)}</Td>
                <Td muted>{STATUS_LABEL[e.status]}</Td>
              </tr>
            ))}
          </Table>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950 sm:p-5">
      <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      {children}
    </section>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-zinc-500">{children}</p>;
}
function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
            {head.map((h, i) => (
              <th key={i} className="py-1.5 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">{children}</tbody>
      </table>
    </div>
  );
}
function Td({ children, muted, right }: { children: React.ReactNode; muted?: boolean; right?: boolean }) {
  return (
    <td
      className={`py-2 pr-3 align-middle ${muted ? "text-xs text-zinc-500" : "text-zinc-800 dark:text-zinc-200"} ${right ? "text-right whitespace-nowrap" : ""}`}
    >
      {children}
    </td>
  );
}
function Btn({
  children,
  onClick,
  disabled,
  primary,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  const cls = primary
    ? "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
    : danger
      ? "border border-red-300 bg-white text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-zinc-900 dark:text-red-300 dark:hover:bg-red-950/40"
      : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`ml-1.5 inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${cls}`}
    >
      {children}
    </button>
  );
}
