import "server-only";
import { randomUUID } from "node:crypto";
import { getRedis } from "@/lib/server/redis";
import type { BondLayoutInput } from "@/types/bondLayout";

/**
 * 업로드한 채권 보관(오너 지시) — 올린 채권은 조회 가능한 모든 사람이 본다.
 * 올리기·삭제는 승인 계정만(API 가 막는다). Upstash Redis 해시 하나에 id → JSON 으로
 * 둔다. Redis 가 없으면(로컬) 프로세스 메모리 — 서버를 다시 켜면 사라진다.
 */

export interface UploadedBond {
  id: string;
  /** 목록에 보일 이름(채권명, 없으면 파일에서 읽은 만기일 등) */
  name: string;
  maturityDate: string;
  couponRate: string;
  uploadedAt: string;
  uploadedBy: string;
  /** 업로드로 읽은 항목만(신탁금액 같은 개인 입력은 넣지 않는다) */
  fields: Partial<BondLayoutInput>;
}

const HASH_KEY = "uploaded-bonds:v1";
const MAX_BONDS = 500;
const memory = new Map<string, UploadedBond>();

export async function listUploadedBonds(): Promise<UploadedBond[]> {
  const redis = getRedis();
  let all: UploadedBond[];
  if (redis) {
    const raw = await redis.hgetall<Record<string, UploadedBond | string>>(HASH_KEY);
    all = Object.values(raw ?? {}).map((v) =>
      typeof v === "string" ? (JSON.parse(v) as UploadedBond) : v
    );
  } else {
    all = [...memory.values()];
  }
  return all.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export async function saveUploadedBond(
  fields: Partial<BondLayoutInput>,
  uploadedBy: string
): Promise<UploadedBond | { error: string }> {
  const existing = await listUploadedBonds();
  if (existing.length >= MAX_BONDS) return { error: "보관 가능한 채권 수를 넘었습니다." };
  const bond: UploadedBond = {
    id: randomUUID(),
    name: (fields.name ?? "").trim() || "(이름 없음)",
    maturityDate: fields.maturityDate ?? "",
    couponRate: fields.couponRate ?? "",
    uploadedAt: new Date().toISOString(),
    uploadedBy,
    fields,
  };
  const redis = getRedis();
  if (redis) await redis.hset(HASH_KEY, { [bond.id]: JSON.stringify(bond) });
  else memory.set(bond.id, bond);
  return bond;
}

export async function getUploadedBond(id: string): Promise<UploadedBond | null> {
  return (await listUploadedBonds()).find((b) => b.id === id) ?? null;
}

export async function deleteUploadedBond(id: string): Promise<void> {
  const redis = getRedis();
  if (redis) await redis.hdel(HASH_KEY, id);
  else memory.delete(id);
}
