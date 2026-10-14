"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BondLayoutInput } from "@/types/bondLayout";

interface UploadedBondSummary {
  id: string;
  name: string;
  maturityDate: string;
  couponRate: string;
  uploadedAt: string;
  /** 서버가 판정: 지울 수 있는 사람(올린 본인·관리자)에게만 true */
  canDelete: boolean;
  fields: Partial<BondLayoutInput>;
}

/**
 * 업로드 채권 검색 — 다른 검색 링크(글로벌종목검색 등)와 같은 모양: 링크를 누르면
 * 팝업이 열리고 검색 칸과 목록이 나온다. 올린 채권은 조회 가능한 모든 사람이 고를 수
 * 있고, 삭제는 올린 사람 본인 또는 관리자에게만 보인다(서버가 다시 확인한다).
 * `refreshKey` 가 바뀌면(업로드 직후) 목록을 다시 불러온다.
 */
export function UploadedBondsBox({
  refreshKey,
  disabled,
  active,
  onApply,
}: {
  refreshKey: number;
  disabled?: boolean;
  /** 마지막으로 반영한 곳이 이 검색일 때만 상태 문구를 보인다 */
  active: boolean;
  onApply: (fields: Partial<BondLayoutInput>) => void;
}) {
  const [bonds, setBonds] = useState<UploadedBondSummary[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/uploaded-bonds", { cache: "no-store" });
      const data = (await res.json()) as { bonds?: UploadedBondSummary[] };
      setBonds(data.bonds ?? []);
    } catch {
      setBonds((prev) => prev ?? []);
    }
  }, []);

  // 업로드 직후에 최신 목록을 받는다(팝업을 열 때도 다시 받는다)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!bonds) return [];
    if (!q) return bonds;
    return bonds.filter((b) =>
      [b.name, b.maturityDate, b.couponRate, b.fields.isin ?? ""].some((v) =>
        v.toLowerCase().includes(q)
      )
    );
  }, [bonds, query]);

  const toggle = () => {
    setError(null);
    if (!open) void load();
    setOpen((v) => !v);
  };

  const select = (bond: UploadedBondSummary) => {
    onApply(bond.fields);
    setStatus(`‘${bond.name}’을(를) 불러왔습니다.`);
    setOpen(false);
    setQuery("");
  };

  const remove = async (bond: UploadedBondSummary) => {
    if (!window.confirm(`'${bond.name}' 을(를) 업로드 목록에서 지울까요?`)) return;
    const res = await fetch(`/api/uploaded-bonds?id=${encodeURIComponent(bond.id)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setError(null);
      void load();
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "삭제하지 못했습니다.");
    }
  };

  return (
    <div className="relative inline-flex items-center gap-2" ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={toggle}
        className="text-sm font-medium text-blue-600 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-zinc-400 dark:text-blue-400 dark:disabled:text-zinc-600"
      >
        업로드검색
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-80 rounded-lg border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="채권명·ISIN·만기로 검색 (예: KORELE)"
            className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-blue-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />

          {bonds === null && (
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">불러오는 중...</p>
          )}

          {bonds !== null && (
            <ul className="mt-2 max-h-56 overflow-y-auto">
              {filtered.map((bond) => (
                <li key={bond.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => select(bond)}
                    className="block min-w-0 flex-1 rounded px-2 py-1 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <span className="block truncate">{bond.name}</span>
                    <span className="text-xs text-zinc-400">
                      만기 {bond.maturityDate || "-"}
                      {bond.couponRate ? ` · ${bond.couponRate}%` : ""}
                      {bond.fields.isin ? ` · ${bond.fields.isin}` : ""}
                    </span>
                  </button>
                  {bond.canDelete && (
                    <button
                      type="button"
                      onClick={() => void remove(bond)}
                      className="shrink-0 rounded px-1.5 py-1 text-xs text-zinc-400 hover:text-red-600 hover:underline dark:hover:text-red-400"
                    >
                      삭제
                    </button>
                  )}
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="px-2 py-1 text-xs text-zinc-400">
                  {bonds.length === 0 ? "업로드한 채권이 없습니다." : "일치하는 채권이 없습니다."}
                </li>
              )}
            </ul>
          )}

          {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}

      {active && status && !open && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{status}</p>
      )}
    </div>
  );
}
