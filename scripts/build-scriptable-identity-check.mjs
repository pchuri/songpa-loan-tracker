// 본인 확인 진단 스크립트 생성기 (결정적).
// scriptable/songpa-loan-tracker.js 끝의 정확한 진입점
//   await main();
//   Script.complete();
// 만 진단 진입점(identityCheckMain)으로 바꿔 scriptable/songpa-identity-check.js 를 만든다. 그 밖의 내용은 한 글자도 바꾸지 않는다.
// 생성본은 그 자체로 완결된 단일 파일이다 (importModule·별도 URL 불러오기 없음).
//
//   node scripts/build-scriptable-identity-check.mjs           # 생성
//   node scripts/build-scriptable-identity-check.mjs --check   # 생성본이 최신인지 확인만 (다르면 종료 코드 1)
//
// 이 생성기는 네트워크·키체인·iCloud에 접근하지 않고, 생성본을 실행하지 않는다.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TRACKER_PATH = path.join(ROOT, "scriptable", "songpa-loan-tracker.js");
export const OUTPUT_PATH = path.join(ROOT, "scriptable", "songpa-identity-check.js");

export const PRODUCTION_ENTRY = "\nawait main();\nScript.complete();\n";
export const DIAGNOSTIC_ENTRY =
  "\n// 진단 전용 진입점 (scripts/build-scriptable-identity-check.mjs 생성본). 목록 조회·업데이트·저장 없음.\n" +
  "await identityCheckMain();\nScript.complete();\n";

export function buildIdentityCheck(source) {
  const src = String(source);
  if (src.includes("\r")) throw new Error("tracker source must use LF line endings");
  if (!src.endsWith(PRODUCTION_ENTRY)) throw new Error("tracker source must end with the exact production entrypoint");
  if (src.indexOf("\nawait main();") !== src.length - PRODUCTION_ENTRY.length) {
    throw new Error("tracker source must contain exactly one top-level `await main();` entrypoint");
  }
  if (!/\nasync function identityCheckMain\(\)/.test(src)) throw new Error("tracker source must define identityCheckMain()");
  if (src.includes("await identityCheckMain();")) throw new Error("tracker source must not already call identityCheckMain()");
  return src.slice(0, src.length - PRODUCTION_ENTRY.length) + DIAGNOSTIC_ENTRY;
}

function cli(argv) {
  const out = buildIdentityCheck(readFileSync(TRACKER_PATH, "utf8"));
  if (argv.includes("--check")) {
    const current = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, "utf8") : null;
    if (current !== out) {
      console.error("scriptable/songpa-identity-check.js is missing or out of date");
      process.exitCode = 1;
      return;
    }
    console.log("scriptable/songpa-identity-check.js is up to date");
    return;
  }
  writeFileSync(OUTPUT_PATH, out);
  console.log(`wrote ${path.relative(ROOT, OUTPUT_PATH)} (${out.length} chars)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli(process.argv.slice(2));
}
