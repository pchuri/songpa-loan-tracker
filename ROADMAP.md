# Roadmap

송파구립도서관 대출·예약 현황을 여러 형태로 제공하는 것을 목표로 한다.
파이썬 형태(데스크톱·스킬)는 `core/` 파서를 공유한다. iPhone Scriptable은 JavaScript라 파서가 따로 있어
도서관 사이트가 바뀌면 `core/`와 `scriptable/songpa-loan-tracker.js`를 함께 고친다.

## Phase 1 — 데스크톱 앱 공개 (완료)

- [x] `songpa-loan-tracker` 리포 생성 (히스토리 없는 새 출발)
- [x] 이전 프로젝트 명칭 제거, 자동 업데이트 탑재
- [x] public 전환
- [x] Windows 배포 (songpa-loan-tracker.exe, `latest-build` 릴리스)

## Phase 2 — 코딩 에이전트용 스킬 (제네릭 버전)

- 개인용으로 쓰던 스킬은 특정 가족 계정 기준이라 그대로 배포 불가
- 가족 정보를 뺀 제네릭 버전을 이 리포의 `skills/`에 추가
- `core/` 파서 공유, 네트워크 전제조건 명시 (splib.or.kr에 닿는 네트워크에서만 동작)

## Phase 3 — iPhone Scriptable (제네릭 버전)

- [x] iCloud Drive에 배포된 동작 검증 위젯을 제네릭 버전으로 정리해 배포 (`scriptable/`)
- [x] 계정 설정 방식 문서화 (`songpa-accounts.js`, 입력받아 키체인 저장)
- Scriptable은 JavaScript라 `core/` 파서를 공유하지 못한다. 사이트 변경 시 `scriptable/songpa-loan-tracker.js`도 함께 고친다.

## 전제조건 (공통)

- splib.or.kr에 직접 닿는 네트워크에서만 동작한다 (집·휴대폰 O, 클라우드 서버 X)
