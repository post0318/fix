// 영업점 오프라인 zip/bat 배포용 정적 export 빌드.
// 서버가 필요한 파일은 output:"export"와 호환되지 않으므로 빌드하는 동안 잠깐
// 프로젝트 밖(.offline-hidden)으로 옮겨 빌드 대상에서 제외했다가 끝나면 되돌린다.
//  - src/app/api          : 서버 전용 라우트
//  - src/app/admin        : 승인 관리 화면(서버에서 권한 확인)
//  - src/components/admin : 위 화면이 api 라우트의 타입을 가져다 쓴다
//  - src/proxy.ts         : Clerk 세션 프록시(서버 전용)
// 이 모드에서는 layout 이 인증을 끄므로 업로드·출력은 잠긴 채 남는다.
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const hiddenRoot = path.join(root, ".offline-hidden");
const targets = [
  ["src", "app", "api"],
  ["src", "app", "admin"],
  ["src", "components", "admin"],
  ["src", "proxy.ts"],
];
const moved = [];

// 서버 쪽 파일이 있던 이전 빌드(npm run dev 포함)의 타입 캐시가 남아 있으면
// 방금 숨긴 파일을 참조하다 타입체크가 실패하므로 먼저 지운다.
const nextCacheDir = path.join(root, ".next");
if (existsSync(nextCacheDir)) {
  rmSync(nextCacheDir, { recursive: true, force: true });
}

function restore() {
  for (const [from, to] of moved.reverse()) {
    renameSync(to, from);
  }
  rmSync(hiddenRoot, { recursive: true, force: true });
  if (moved.length) console.log("[build-offline] 제외했던 파일을 원래대로 복원했습니다.");
}

let exitCode = 1;
try {
  mkdirSync(hiddenRoot, { recursive: true });
  for (const parts of targets) {
    const from = path.join(root, ...parts);
    if (!existsSync(from)) continue;
    const to = path.join(hiddenRoot, parts.join("__"));
    renameSync(from, to);
    moved.push([from, to]);
  }
  console.log(`[build-offline] ${moved.length}개 경로를 임시로 제외했습니다.`);

  const result = spawnSync("npx", ["next", "build"], {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, STATIC_EXPORT: "1" },
  });
  exitCode = result.status ?? 1;
} finally {
  restore();
}

process.exit(exitCode);
