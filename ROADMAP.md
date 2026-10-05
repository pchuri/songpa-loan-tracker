# Roadmap

송파구립도서관 대출·예약 현황을 여러 형태로 제공하는 것을 목표로 한다.
파이썬 형태(데스크톱·`songpa` 명령어·스킬)는 `songpa_core/` 파서를 공유한다. iPhone Scriptable(JavaScript)과
안드로이드 앱 반납요정(Kotlin, 별도 저장소 `pchuri/return-fairy`)은 파서가 따로 있어
도서관 사이트가 바뀌면 `songpa_core/`, `scriptable/songpa-loan-tracker.js`, 반납요정 `core/`를 함께 고친다.

## Phase 1 — 데스크톱 앱 공개 (완료)

- [x] `songpa-loan-tracker` 리포 생성 (히스토리 없는 새 출발)
- [x] 이전 프로젝트 명칭 제거, 자동 업데이트 탑재
- [x] public 전환
- [x] Windows 배포 (songpa-loan-tracker.exe, `latest-build` 릴리스)

## Phase 2 — `songpa` 명령어와 코딩 에이전트용 스킬

- [x] `songpa_core/` 파서를 쓰는 `songpa` 명령어 (`songpa_cli/`): 요약, JSON, 카드 화면(HTML), Termux 알림
- [x] 계정은 사용자가 등록 (`songpa accounts add`). macOS·Windows는 OS 키체인, Termux·리눅스는 권한 600 파일
- [x] PySide6 없이 설치 가능하게 의존성 분리 (데스크톱 의존성은 uv `desktop` 그룹)
- [x] 가족 정보 없는 제네릭 스킬 `skills/songpa/SKILL.md`, 네트워크 전제조건 명시

## Phase 3 — iPhone Scriptable (제네릭 버전)

- [x] iCloud Drive에 배포된 동작 검증 위젯을 제네릭 버전으로 정리해 배포 (`scriptable/`)
- [x] 계정 설정 방식 문서화 (`songpa-accounts.js`, 입력받아 키체인 저장)
- Scriptable은 JavaScript라 `songpa_core/` 파서를 공유하지 못한다. 사이트 변경 시 `scriptable/songpa-loan-tracker.js`도 함께 고친다.

## Phase 4 — 안드로이드 앱 (별도 저장소)

- [x] 반납요정을 APK 직접 배포로 공개 (`pchuri/return-fairy`, GitHub Releases, 앱 안 새 버전 확인)
- [x] 4.0: 이 저장소의 카드 화면과 같은 대시보드로 다시 설계, `songpa_core` 기준으로 조회 코드 이식, 매일 알림

## 전제조건 (공통)

- splib.or.kr에 직접 닿는 네트워크에서만 동작한다 (집·휴대폰 O, 클라우드 서버 X)
