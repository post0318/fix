/**
 * 서버가 원본 대신 마지막 정상값을 줬을 때(staleSince) 화면에 붙이는 안내 문구.
 * 시각은 한국 시간 "MM/DD HH:mm". staleSince 가 없으면 null.
 */
export function staleNote(staleSince: string | null | undefined): string | null {
  if (!staleSince) return null;
  const d = new Date(staleSince);
  if (Number.isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("month")}/${v("day")} ${v("hour")}:${v("minute")} 저장본 (원본 응답 실패)`;
}
