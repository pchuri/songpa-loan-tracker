---
name: songpa
description: 송파구립도서관(splib.or.kr) 대출·상호대차·예약 현황을 songpa 명령어로 조회한다. "도서관 대출 현황", "반납 언제야", "상호대차 도착했어?", "예약한 책 왔어?" 같은 질문에 사용. 조회 전용이며 연장·예약·취소는 하지 않는다.
---

# songpa — 송파구립도서관 대출 현황 조회

`songpa` 명령어로 등록된 계정들의 대출·상호대차·예약 현황을 읽는다. 조회만 하며 도서관 홈페이지에서
아무것도 바꾸지 않는다.

## 전제 조건

- `songpa`가 설치돼 있어야 한다: `uv tool install git+https://github.com/pchuri/songpa-loan-tracker`
  (설치 확인: `songpa --version`)
- 계정이 등록돼 있어야 한다: `songpa accounts list`. 없으면 사용자에게 직접 `songpa accounts add`를
  실행해 달라고 안내한다. **비밀번호를 대화로 받거나 명령줄 인자로 넘기지 않는다.**
- splib.or.kr에 직접 닿는 네트워크에서만 동작한다. 이 명령은 사용자 PC·휴대폰처럼 로컬에서 도는
  에이전트에서만 쓴다. 클라우드 샌드박스나 회사 VPN에서는 접속이 막혀 실패할 수 있다.

## 사용법

```bash
songpa --json                 # 전체 계정 (분석·답변용으로 권장)
songpa --json -u 홍길동       # 특정 계정만 (이름이나 아이디, 여러 번 가능)
songpa                        # 사람이 읽는 요약
songpa --html                 # 카드 화면을 브라우저로 열기 (사용자가 화면을 원할 때)
songpa --due-soon 5 --json    # 반납 임박 기준을 5일로
```

종료 코드: `0` 성공, `1` 일부 계정 조회 실패(결과는 출력됨), `2` 계정 미등록·잘못된 옵션.

## JSON 읽는 법

```json
{
  "fetched_at": "2026-10-05T09:30:00",
  "accounts": [
    {
      "label": "홍길동",
      "name": "홍길동",
      "book_count": 3,
      "interlibrary_count": 2,
      "ready_for_pickup_count": 1,
      "books": [
        {"title": "...", "status": "loaned", "due_date": "2026.10.07", "days_left": 2,
         "transit_status": null, "is_interlibrary": true, "library": "거마", "providing_library": "위례"}
      ],
      "reservations": [
        {"title": "...", "library": "잠실", "ready_for_pickup": true, "pickup_deadline": "2026.10.08",
         "rank": null, "waiting_count": null, "reserved_date": "2026.09.30"}
      ]
    }
  ]
}
```

- `books[].status`
  - `loaned`: 대출 중. `days_left`가 음수면 연체, 0이면 오늘 반납.
  - `ready_for_pickup`: 상호대차 책이 `library`(수령 도서관)에 도착. 찾아와야 한다.
  - `in_transit`: 상호대차 신청·이동 중. `transit_status`에 사이트 상태(`발송`·`요청중`·`신청중`).
- `is_interlibrary`: 상호대차(책솔이 포함) 여부. 상호대차 대출은 `library`가 수령·반납 도서관,
  `providing_library`가 책을 보내 준 도서관이다.
- `book_count`·`interlibrary_count`는 데스크톱 앱·아이폰 위젯의 `대출권수 (상호대차)` 표시와 같은 기준이다
  (도착·이동 중인 상호대차 건 포함).
- `reservations[].ready_for_pickup`이 true면 예약한 책이 도착해 `pickup_deadline`까지 찾아가야 한다.
  아니면 `rank`가 대기 순번이다.
- 계정에 `error`가 있으면 그 계정은 조회 실패다(비밀번호 오류, 접속 실패 등). 다른 계정 결과는 정상이다.

## 답변 요령

- 날짜는 `fetched_at` 기준이다. "오늘", "내일"을 말할 때 이 시각을 기준으로 한다.
- 급한 것부터: 연체·오늘 반납 → 찾아올 책(`ready_for_pickup`, 예약 도착) → 반납 임박 → 나머지.
- 계정 아이디는 답변에 쓰지 않고 `label`로 부른다.
