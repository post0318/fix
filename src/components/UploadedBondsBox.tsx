"use client";

import { useCallback, useEffect, useState } from "react";
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
 * 업로드한 채권 보관함 — 올린 채권은 조회 가능한 모든 사람이 골라 쓸 수 있다.
 * 삭제는 승인 계정에게만 보이고, 올린 사람 본인 또는 관리자만 서버가 허용한다.
 * `refreshKey` 가 바뀌면(업로드 직후) 목록을 다시 불러온다.
 */
export function UploadedBondsBox({
  refreshKey,
  disabled,
  onApply,
}: {
  refreshKey: number;
  disabled?: boolean;
  onApply: (fields: Partial<BondLayoutInput>) => void;
}) {
  const [bonds, setBonds] = useState<UploadedBondSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/uploaded-bonds", { cache: "no-store" });
      const data = (await res.json()) as { bonds?: UploadedBondSummary[] };
      setBonds(data.bonds ?? []);
    } catch {
      // 목록을 못 불러와도 화면의 나머지는 그대로 쓴다
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  const remove = async () => {
    const bond = bonds.find((b) => b.id === selected);
    if (!bond || !window.confirm(`'${bond.name}' 을(를) 보관함에서 지울까요?`)) return;
    const res = await fetch(`/api/uploaded-bonds?id=${encodeURIComponent(bond.id)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setSelected("");
      setStatus(null);
      void load();
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setStatus(data.error ?? "삭제하지 못했습니다.");
    }
  };

  if (bonds.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <select
        disabled={disabled}
        value={selected}
        onChange={(e) => {
          const bond = bonds.find((b) => b.id === e.target.value);
          setSelected(e.target.value);
          setStatus(null);
          if (bond) onApply(bond.fields);
        }}
        className="max-w-56 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
        aria-label="업로드한 채권"
      >
        <option value="">업로드 채권 ({bonds.length})</option>
        {bonds.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
            {b.maturityDate ? ` · ${b.maturityDate}` : ""}
          </option>
        ))}
      </select>
      {bonds.find((b) => b.id === selected)?.canDelete && (
        <button
          type="button"
          onClick={() => void remove()}
          className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          삭제
        </button>
      )}
      {status && <span className="text-xs text-red-600 dark:text-red-400">{status}</span>}
    </div>
  );
}
