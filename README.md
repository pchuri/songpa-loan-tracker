# songpa-loan-tracker

송파구립도서관(splib.or.kr) 대출·예약 현황을 한눈에 보여주는 macOS/Windows 데스크톱 앱입니다.
PySide6로 구현되었으며, 별도의 백엔드 없이 독립 실행됩니다. 도서관 홈페이지에 직접 로그인해서
조회하므로, 클라우드 서버에서는 접속이 차단되는 환경에서도 집 PC에서는 정상 동작합니다.

> 스크린샷 자리 (TODO: 대출 탭 / 예약 탭 캡처 추가)

## 다운로드

별도 설치 없이 실행 파일 하나로 동작합니다. [Releases](../../releases)의 `latest-build`에서
최신 빌드를 받으세요.

- macOS: `JenaonBot-macos.zip` → 압축 해제 후 `JenaonBot.app` 실행
- Windows: `JenaonBot.exe` 실행

첫 실행 시 도서관 회원번호와 비밀번호를 설정 탭에 입력하면 됩니다. 입력한 계정 정보는
PC에만 암호화되어 저장되고 외부로 전송되지 않습니다.

## 주요 기능

- 📚 **대출 도서 관리**: 계층형 트리 뷰로 사용자별 대출 현황 확인
- 🔖 **예약 도서 관리**: 예약 순번과 수령 마감일 확인, 같은 책을 여러 도서관에 걸어둔 예약은 책별로 묶어 정렬
- 🔍 **정렬 및 필터링**: 반납일/이름/도서관별 정렬, 상호대차 필터링
- ⏰ **자동 새로고침**: 5분/10분/30분/1시간 간격 선택 가능
- 🌓 **다크모드**: 라이트/다크 테마 전환
- 🔔 **시스템 트레이**: 백그라운드 실행 및 빠른 액세스
- ⌨️ **키보드 단축키**: F5(새로고침), Ctrl+1(대출)/Ctrl+2(예약)/Ctrl+3(설정)
- 👥 **다중 사용자**: 여러 도서관 계정 관리

## 프로젝트 구조

- `src/main_app.py` — PySide6 GUI 메인 애플리케이션
- `core/` — 도서관 웹 스크래핑 로직
- `JenaonBot.spec` — PyInstaller 빌드 설정

## 개발 환경 설정

### 1. uv 설치 및 의존성 설치
```bash
cd songpa-loan-tracker

# uv 설치 (최초 1회)
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.local/bin/env

# 의존성 설치 및 가상환경 생성
uv sync

# 앱 실행
uv run src/main_app.py
```

## 사용 방법

1. **설정 탭**에서 도서관 계정 추가
   - 회원번호와 비밀번호 입력
   - "추가 / 수정" 버튼 클릭
   - "저장 및 적용" 버튼으로 설정 저장

2. **대출 현황 탭**에서 도서 확인
   - "새로고침" 버튼으로 최신 정보 조회
   - 도서 카드 클릭으로 상세 정보 확인
   - 정렬/필터 옵션으로 목록 관리

3. **예약 현황 탭에서 예약 확인**
   - 수령 마감일이 걸린 예약은 정렬과 무관하게 항상 맨 위에 표시
   - "책별" 정렬로 같은 책을 걸어둔 도서관들을 나란히 비교 (순번이 빠른 곳부터)
   - 카드 클릭으로 자료실 위치와 예약만기일 확인

4. **선택 사항**
   - 자동 새로고침 간격 설정
   - 다크모드 활성화
   - 시스템 트레이로 최소화

설정은 `~/.jenaonbot/config.json`에 자동 저장됩니다.

## macOS 앱 빌드

### 방법 1: 로컬 빌드

```bash
# PyInstaller 설치
uv pip install pyinstaller

# 빌드 실행
.venv/bin/pyinstaller JenaonBot.spec

# 빌드된 앱 실행
open dist/JenaonBot.app
```

빌드된 `JenaonBot.app`은 다른 Mac에서도 실행 가능합니다 (Python 설치 불필요).

### 방법 2: GitHub Actions 자동 빌드

1. GitHub 저장소의 **Actions** 탭 이동
2. **build-desktop** workflow 선택
3. **Run workflow** 버튼 클릭
4. 완료 후 **Artifacts**에서 다운로드
   - `JenaonBot-macos` (macOS용)
   - `JenaonBot-windows` (Windows용)

## 배포

### ZIP 파일로 배포
```bash
cd dist
zip -r JenaonBot-macOS.zip JenaonBot.app
```

### DMG 생성 (선택)
```bash
brew install create-dmg
create-dmg \
  --volname "JenaonBot Installer" \
  --window-pos 200 120 \
  --window-size 800 400 \
  --icon-size 100 \
  --app-drop-link 600 185 \
  JenaonBot-Installer.dmg \
  dist/JenaonBot.app
```

### 코드 서명 (권장)
Apple Developer 계정이 있는 경우:
```bash
codesign --deep --force --verify --verbose \
  --sign "Developer ID Application: YOUR_NAME" \
  dist/JenaonBot.app
```

### 키체인 접근 권한 유지 (ad-hoc 서명 문제)

앱은 비밀번호 암호화용 마스터 키를 macOS 로그인 키체인(서비스 `jenaonbot`)에
저장합니다. PyInstaller 기본 빌드는 ad-hoc 서명이라 빌드할 때마다 서명이 바뀌고,
macOS 키체인 ACL은 이를 매번 다른 앱으로 취급해 접근 허용 프롬프트를 다시
띄웁니다. 프롬프트를 승인할 수 없는 환경(예: 로그인 키체인 비밀번호 불일치)에서는
앱이 저장된 비밀번호를 읽지 못합니다.

해결 방법은 **빌드 간에 유지되는 고정 서명 identity**로 서명하는 것입니다.
Apple Developer 계정이 없으면 자체 서명 인증서로도 충분합니다:

1. **키체인 접근** 앱 → 메뉴 `키체인 접근 > 인증서 지원 > 인증서 생성...`
   - 이름: `JenaonBot Dev` (임의), 인증서 유형: **코드 서명**, 로그인 키체인에 저장
2. `CODESIGN_IDENTITY` 환경 변수로 빌드하면 자동으로 서명됩니다:
   ```bash
   CODESIGN_IDENTITY="JenaonBot Dev" .venv/bin/pyinstaller JenaonBot.spec
   ```
   변수를 지정하지 않으면 기존과 동일하게 ad-hoc 서명됩니다. 인증서가 없는
   CI 빌드가 실패하지 않도록 opt-in으로 두었습니다. 이미 빌드된 앱에
   나중에 서명하려면 `codesign --force --deep --sign "JenaonBot Dev" dist/JenaonBot.app`.

   서명 확인: `codesign -dvv dist/JenaonBot.app` 출력에 `Authority=JenaonBot Dev`가
   보이면 정상입니다 (ad-hoc이면 Authority 줄이 없습니다). 서명만 확인하지 말고
   앱이 실제로 뜨는지도 확인하세요.

   서명 시 `resources/entitlements.plist`가 함께 적용됩니다. 자체 서명 인증서는
   Team ID가 없어서 하드닝 런타임의 라이브러리 검증이 번들된 libpython/Qt 로드를
   거부하는데(`different Team IDs`), 이 plist의 `disable-library-validation`이
   그것을 해제합니다. Developer ID로 공증까지 하면 필요 없습니다.
3. 서명된 앱을 처음 실행할 때 키체인 프롬프트에서 **항상 허용**을 선택하면,
   이후 같은 identity로 서명된 빌드에서는 프롬프트가 다시 나타나지 않습니다.

키체인 접근이 거부되어도 앱은 크래시 없이 실행되며(계정 목록은 표시되지만
비밀번호는 비어 있음) 저장된 암호화 비밀번호는 삭제되지 않습니다. 키체인 접근을
허용한 뒤 앱을 다시 실행하면 자동으로 복구됩니다.

## 라이선스

MIT — [LICENSE](LICENSE) 참조
