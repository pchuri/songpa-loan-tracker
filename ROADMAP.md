# Roadmap

송파구립도서관 대출·예약 현황을 여러 형태로 제공하는 것을 목표로 한다.
모든 형태는 `core/` 파서를 공유하며, 도서관 사이트 변경 시 고치는 곳은 한 군데다.

## Phase 1 — 데스크톱 앱 공개 (진행 중)

- [x] `songpa-loan-tracker` 리포 생성 (히스토리 없는 새 출발)
- [x] jenaonbot 명칭 제거, 자동 업데이트 탑재
- [ ] public 전환
- [ ] Windows 배포 (songpa-loan-tracker.exe)

## Phase 2 — 코딩 에이전트용 스킬 (제네릭 버전)

- home 리포의 `jenaon-library` 스킬(v1.0.0)은 가족 전용(private)이라 그대로 배포 불가
- 가족 정보를 뺀 제네릭 버전을 이 리포의 `skills/`에 추가
- `core/` 파서 공유, 네트워크 전제조건 명시 (splib.or.kr에 닿는 네트워크에서만 동작)

## Phase 3 — iPhone Scriptable (제네릭 버전)

- iCloud Drive에 배포된 동작 검증 위젯을 제네릭 버전으로 정리해 배포
- 계정 설정 방식 문서화

## 전제조건 (공통)

- splib.or.kr에 직접 닿는 네트워크에서만 동작한다 (집·휴대폰 O, 클라우드 서버 X)
