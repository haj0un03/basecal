// 가상 데이터 (Phase 0~4 전용)
// - 모든 이름과 일정은 지어낸 것이다. 실제 병사 정보를 넣지 않는다.
// - 표 이름은 prd.md 7번(Supabase 표 이름)과 같다. Phase 5에서 저장만 바꿔 끼운다.
// - 화면 코드는 이 파일을 직접 읽지 않고, 데이터 계층(Phase 1에서 만든다)을 거친다.
// - 개인 코드는 Supabase 인증이 따로 관리하므로 profiles에 넣지 않는다 (아래 mockAuth).
//
// 값의 뜻
// - profiles.role: soldier(병사), officer(간부)
// - profiles.position: 보직. 간부가 직접 입력한다 (20자 이하)
// - events.type: personal(개인), duty(근무), unit(부대), leave(휴가), overnight(외박), outing(외출)
// - events.unit_category: training(훈련), inspection(점검), event(행사), other(기타)
//   훈련은 제목과 설명 없이 "훈련"으로만 표시하므로 title을 비워 둔다.
// - leave_grants: 받은 휴가 일수·포상 횟수. leave_type: annual(연가), reward(포상휴가), consolation(위로휴가),
//   overnight_pass(포상 외박, 횟수), outing_pass(포상 외출, 횟수). 포상 외박·외출은 days에 횟수를 넣는다.
//   status: pending(대기), approved(승인), rejected(반려). 승인된 것만 남은 일수에 들어간다.
//   일수는 모두 가상 값이다.
// - merit_points: 상점·벌점. kind: merit(상점, +점수), demerit(벌점, -점수), conversion(전환, -점수)
//   given_points: 간부가 처음 준 점수. 벌점은 상점을 0점까지만 깎으므로 points보다 클 수 있다.
//   남은 상점 = points 합계 (저장하지 않고 매번 계산). 점수는 모두 가상 값이다.
// - leave_requests.kind: leave(휴가), overnight(외박), outing(외출) / status: requested(신청), cancelled(취소)
// - leave_settings: 기본 출타율(%). kind별 가장 최근 값을 쓴다 (가상 값: 휴가 20%, 외박·외출 10%)
// - leave_rate_periods: 기간별 출타율. 그 기간에는 기본 출타율 대신 이 값을 쓴다
// - 가상 휴가 신청: 11/12~13에 4명(정원 4명이라 마감), 11/5~6에 1명
// - facilities의 운영 시간은 아직 정해지지 않아 임시 값이다 (prd.md 11번).

export const mockDb = {
  "profiles": [
    {
      "id": "u01",
      "name": "김하늘",
      "role": "soldier",
      "position": "소총수",
      "enlist_date": "2025-05-04",
      "discharge_date": "2026-11-03",
      "is_active": true
    },
    {
      "id": "u02",
      "name": "이바다",
      "role": "soldier",
      "position": "운전병",
      "enlist_date": "2025-05-29",
      "discharge_date": "2026-11-28",
      "is_active": true
    },
    {
      "id": "u03",
      "name": "박가온",
      "role": "soldier",
      "position": "취사병",
      "enlist_date": "2025-06-23",
      "discharge_date": "2026-12-22",
      "is_active": true
    },
    {
      "id": "u04",
      "name": "최나래",
      "role": "soldier",
      "position": "통신병",
      "enlist_date": "2025-07-18",
      "discharge_date": "2027-01-17",
      "is_active": true
    },
    {
      "id": "u05",
      "name": "정다온",
      "role": "soldier",
      "position": "의무병",
      "enlist_date": "2025-08-12",
      "discharge_date": "2027-02-11",
      "is_active": true
    },
    {
      "id": "u06",
      "name": "강보람",
      "role": "soldier",
      "position": "행정병",
      "enlist_date": "2025-09-06",
      "discharge_date": "2027-03-05",
      "is_active": true
    },
    {
      "id": "u07",
      "name": "조새벽",
      "role": "soldier",
      "position": "정비병",
      "enlist_date": "2025-10-01",
      "discharge_date": "2027-03-31",
      "is_active": true
    },
    {
      "id": "u08",
      "name": "윤겨울",
      "role": "soldier",
      "position": "소총수",
      "enlist_date": "2025-10-26",
      "discharge_date": "2027-04-25",
      "is_active": true
    },
    {
      "id": "u09",
      "name": "장한결",
      "role": "soldier",
      "position": "소총수",
      "enlist_date": "2025-11-20",
      "discharge_date": "2027-05-19",
      "is_active": true
    },
    {
      "id": "u10",
      "name": "임도담",
      "role": "soldier",
      "position": "경계병",
      "enlist_date": "2025-12-15",
      "discharge_date": "2027-06-14",
      "is_active": true
    },
    {
      "id": "u11",
      "name": "한마루",
      "role": "soldier",
      "position": "소총수",
      "enlist_date": "2026-01-09",
      "discharge_date": "2027-07-08",
      "is_active": true
    },
    {
      "id": "u12",
      "name": "오여름",
      "role": "soldier",
      "position": "운전병",
      "enlist_date": "2026-02-03",
      "discharge_date": "2027-08-02",
      "is_active": true
    },
    {
      "id": "u13",
      "name": "서누리",
      "role": "soldier",
      "position": "취사병",
      "enlist_date": "2026-02-28",
      "discharge_date": "2027-08-27",
      "is_active": true
    },
    {
      "id": "u14",
      "name": "신다솜",
      "role": "soldier",
      "position": "통신병",
      "enlist_date": "2026-03-25",
      "discharge_date": "2027-09-24",
      "is_active": true
    },
    {
      "id": "u15",
      "name": "권별하",
      "role": "soldier",
      "position": "의무병",
      "enlist_date": "2026-04-19",
      "discharge_date": "2027-10-18",
      "is_active": true
    },
    {
      "id": "u16",
      "name": "황이랑",
      "role": "soldier",
      "position": "행정병",
      "enlist_date": "2026-05-14",
      "discharge_date": "2027-11-13",
      "is_active": true
    },
    {
      "id": "u17",
      "name": "안소울",
      "role": "soldier",
      "position": "정비병",
      "enlist_date": "2026-06-08",
      "discharge_date": "2027-12-07",
      "is_active": true
    },
    {
      "id": "u18",
      "name": "송하람",
      "role": "soldier",
      "position": "소총수",
      "enlist_date": "2026-07-03",
      "discharge_date": "2028-01-02",
      "is_active": true
    },
    {
      "id": "u19",
      "name": "전가람",
      "role": "soldier",
      "position": "소총수",
      "enlist_date": "2026-07-28",
      "discharge_date": "2028-01-27",
      "is_active": true
    },
    {
      "id": "u20",
      "name": "홍새롬",
      "role": "soldier",
      "position": "경계병",
      "enlist_date": "2026-08-22",
      "discharge_date": "2028-02-21",
      "is_active": true
    },
    {
      "id": "o01",
      "name": "백지훈",
      "role": "officer",
      "position": "중대장",
      "enlist_date": "2019-03-04",
      "discharge_date": "2029-02-28",
      "is_active": true
    },
    {
      "id": "o02",
      "name": "남궁현",
      "role": "officer",
      "position": "행정보급관",
      "enlist_date": "2021-06-14",
      "discharge_date": "2027-06-30",
      "is_active": true
    }
  ],
  "events": [
    {
      "id": "e01",
      "type": "unit",
      "title": "체육대회",
      "start_date": "2026-10-16",
      "end_date": "2026-10-16",
      "time": null,
      "author_id": "o01",
      "memo": "중대 대항 체육대회",
      "repeat_yearly": false,
      "unit_category": "event"
    },
    {
      "id": "e02",
      "type": "unit",
      "title": "생활관 점검",
      "start_date": "2026-10-21",
      "end_date": "2026-10-21",
      "time": null,
      "author_id": "o01",
      "memo": "",
      "repeat_yearly": false,
      "unit_category": "inspection"
    },
    {
      "id": "e03",
      "type": "unit",
      "title": null,
      "start_date": "2026-10-26",
      "end_date": "2026-10-30",
      "time": null,
      "author_id": "o01",
      "memo": "",
      "repeat_yearly": false,
      "unit_category": "training"
    },
    {
      "id": "e04",
      "type": "leave",
      "title": "휴가",
      "start_date": "2026-11-12",
      "end_date": "2026-11-13",
      "time": null,
      "author_id": "u05",
      "memo": "",
      "repeat_yearly": false,
      "unit_category": null
    },
    {
      "id": "e05",
      "type": "leave",
      "title": "휴가",
      "start_date": "2026-11-12",
      "end_date": "2026-11-13",
      "time": null,
      "author_id": "u06",
      "memo": "",
      "repeat_yearly": false,
      "unit_category": null
    },
    {
      "id": "e06",
      "type": "leave",
      "title": "휴가",
      "start_date": "2026-11-12",
      "end_date": "2026-11-13",
      "time": null,
      "author_id": "u07",
      "memo": "",
      "repeat_yearly": false,
      "unit_category": null
    },
    {
      "id": "e07",
      "type": "leave",
      "title": "휴가",
      "start_date": "2026-11-12",
      "end_date": "2026-11-13",
      "time": null,
      "author_id": "u08",
      "memo": "",
      "repeat_yearly": false,
      "unit_category": null
    },
    {
      "id": "e08",
      "type": "leave",
      "title": "휴가",
      "start_date": "2026-11-05",
      "end_date": "2026-11-06",
      "time": null,
      "author_id": "u10",
      "memo": "",
      "repeat_yearly": false,
      "unit_category": null
    }
  ],
  "leave_grants": [
    {
      "id": "g01",
      "user_id": "u01",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g02",
      "user_id": "u02",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g03",
      "user_id": "u03",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g04",
      "user_id": "u04",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g05",
      "user_id": "u05",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g06",
      "user_id": "u06",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g07",
      "user_id": "u07",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g08",
      "user_id": "u08",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g09",
      "user_id": "u09",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g10",
      "user_id": "u10",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g11",
      "user_id": "u11",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g12",
      "user_id": "u12",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g13",
      "user_id": "u13",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g14",
      "user_id": "u14",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g15",
      "user_id": "u15",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g16",
      "user_id": "u16",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g17",
      "user_id": "u17",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g18",
      "user_id": "u18",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g19",
      "user_id": "u19",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g20",
      "user_id": "u20",
      "leave_type": "annual",
      "days": 24,
      "reason": "정기 연가",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-01-02T09:00:00.000Z",
      "decided_at": "2026-01-02T09:00:00.000Z"
    },
    {
      "id": "g21",
      "user_id": "u01",
      "leave_type": "reward",
      "days": 3,
      "reason": "체육대회 우승",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-10-17T09:00:00.000Z",
      "decided_at": "2026-10-17T09:00:00.000Z"
    },
    {
      "id": "g22",
      "user_id": "u01",
      "leave_type": "consolation",
      "days": 2,
      "reason": "장기 파견 위로",
      "status": "pending",
      "decided_by": null,
      "requested_at": "2026-10-20T09:00:00.000Z",
      "decided_at": null
    },
    {
      "id": "g23",
      "user_id": "u02",
      "leave_type": "reward",
      "days": 2,
      "reason": "경계 근무 유공",
      "status": "pending",
      "decided_by": null,
      "requested_at": "2026-10-21T09:00:00.000Z",
      "decided_at": null
    },
    {
      "id": "g24",
      "user_id": "u03",
      "leave_type": "reward",
      "days": 1,
      "reason": "생활관 점검 우수",
      "status": "rejected",
      "decided_by": "o02",
      "requested_at": "2026-10-15T09:00:00.000Z",
      "decided_at": "2026-10-15T09:00:00.000Z"
    },
    {
      "id": "g25",
      "user_id": "u01",
      "leave_type": "outing_pass",
      "days": 1,
      "reason": "부대 행사 지원",
      "status": "approved",
      "decided_by": "o01",
      "requested_at": "2026-10-18T09:00:00.000Z",
      "decided_at": "2026-10-18T09:00:00.000Z"
    }
  ],
  "merit_points": [
    {
      "id": "m01",
      "user_id": "u01",
      "kind": "merit",
      "points": 50,
      "given_points": 50,
      "reason": "환경 미화 우수",
      "given_by": "o01",
      "grant_id": null,
      "created_at": "2026-09-10T09:00:00.000Z"
    },
    {
      "id": "m02",
      "user_id": "u01",
      "kind": "merit",
      "points": 50,
      "given_points": 50,
      "reason": "사격 우수",
      "given_by": "o02",
      "grant_id": null,
      "created_at": "2026-10-05T09:00:00.000Z"
    },
    {
      "id": "m03",
      "user_id": "u01",
      "kind": "merit",
      "points": 30,
      "given_points": 30,
      "reason": "체력 측정 특급",
      "given_by": "o02",
      "grant_id": null,
      "created_at": "2026-10-07T09:00:00.000Z"
    },
    {
      "id": "m04",
      "user_id": "u01",
      "kind": "demerit",
      "points": -10,
      "given_points": 10,
      "reason": "청소 불량",
      "given_by": "o01",
      "grant_id": null,
      "created_at": "2026-10-12T09:00:00.000Z"
    },
    {
      "id": "m05",
      "user_id": "u02",
      "kind": "merit",
      "points": 30,
      "given_points": 30,
      "reason": "경계 근무 성실",
      "given_by": "o01",
      "grant_id": null,
      "created_at": "2026-10-08T09:00:00.000Z"
    },
    {
      "id": "m06",
      "user_id": "u03",
      "kind": "merit",
      "points": 50,
      "given_points": 50,
      "reason": "체육대회 우승",
      "given_by": "o02",
      "grant_id": null,
      "created_at": "2026-10-16T09:00:00.000Z"
    },
    {
      "id": "m07",
      "user_id": "u03",
      "kind": "merit",
      "points": 50,
      "given_points": 50,
      "reason": "생활관 점검 우수",
      "given_by": "o01",
      "grant_id": null,
      "created_at": "2026-10-17T09:00:00.000Z"
    }
  ],
  "leave_requests": [
    {
      "id": "r01",
      "user_id": "u05",
      "kind": "leave",
      "event_id": "e04",
      "start_date": "2026-11-12",
      "end_date": "2026-11-13",
      "status": "requested",
      "requested_at": "2026-10-20T09:00:00.000Z",
      "cancelled_at": null
    },
    {
      "id": "r02",
      "user_id": "u06",
      "kind": "leave",
      "event_id": "e05",
      "start_date": "2026-11-12",
      "end_date": "2026-11-13",
      "status": "requested",
      "requested_at": "2026-10-20T09:00:00.000Z",
      "cancelled_at": null
    },
    {
      "id": "r03",
      "user_id": "u07",
      "kind": "leave",
      "event_id": "e06",
      "start_date": "2026-11-12",
      "end_date": "2026-11-13",
      "status": "requested",
      "requested_at": "2026-10-20T09:00:00.000Z",
      "cancelled_at": null
    },
    {
      "id": "r04",
      "user_id": "u08",
      "kind": "leave",
      "event_id": "e07",
      "start_date": "2026-11-12",
      "end_date": "2026-11-13",
      "status": "requested",
      "requested_at": "2026-10-20T09:00:00.000Z",
      "cancelled_at": null
    },
    {
      "id": "r05",
      "user_id": "u10",
      "kind": "leave",
      "event_id": "e08",
      "start_date": "2026-11-05",
      "end_date": "2026-11-06",
      "status": "requested",
      "requested_at": "2026-10-21T09:00:00.000Z",
      "cancelled_at": null
    }
  ],
  "leave_request_items": [
    {
      "request_id": "r01",
      "leave_type": "annual",
      "days": 2
    },
    {
      "request_id": "r02",
      "leave_type": "annual",
      "days": 2
    },
    {
      "request_id": "r03",
      "leave_type": "annual",
      "days": 2
    },
    {
      "request_id": "r04",
      "leave_type": "annual",
      "days": 2
    },
    {
      "request_id": "r05",
      "leave_type": "annual",
      "days": 2
    }
  ],
  "leave_settings": [
    {
      "id": "s01",
      "kind": "leave",
      "rate": 20,
      "updated_by": "o01",
      "updated_at": "2026-10-01T09:00:00.000Z"
    },
    {
      "id": "s02",
      "kind": "overnight",
      "rate": 10,
      "updated_by": "o01",
      "updated_at": "2026-10-01T09:00:00.000Z"
    },
    {
      "id": "s03",
      "kind": "outing",
      "rate": 10,
      "updated_by": "o01",
      "updated_at": "2026-10-01T09:00:00.000Z"
    }
  ],
  "leave_rate_periods": [],
  "facilities": [
    {
      "id": "f01",
      "name": "풋살장·운동장",
      "open_time": "09:00",
      "close_time": "18:00",
      "slot_minutes": 60
    },
    {
      "id": "f02",
      "name": "체육관",
      "open_time": "09:00",
      "close_time": "21:00",
      "slot_minutes": 60
    }
  ],
  "reservations": [],
  "audit_logs": []
};

// 로그인 흉내용 개인 코드 (Phase 0~4 전용)
// - 간부가 사람마다 발급하는 영문·숫자 6자리 코드. 헷갈리는 0, O, 1, I, L은 쓰지 않는다.
// - Supabase 인증 기능을 흉내 낸다. Phase 5에서는 Supabase가 해시로 따로 관리하므로 이 목록을 지운다.
// - 가상 인원 전용 연습 코드다. 실제 코드를 넣지 않는다.
export const mockAuth = [
  {
    "user_id": "u01",
    "code": "CZUTP6"
  },
  {
    "user_id": "u02",
    "code": "X4DVGP"
  },
  {
    "user_id": "u03",
    "code": "KM9YWP"
  },
  {
    "user_id": "u04",
    "code": "PESAZ9"
  },
  {
    "user_id": "u05",
    "code": "W95HUP"
  },
  {
    "user_id": "u06",
    "code": "T3TTC3"
  },
  {
    "user_id": "u07",
    "code": "R2M4MF"
  },
  {
    "user_id": "u08",
    "code": "4DEGQ6"
  },
  {
    "user_id": "u09",
    "code": "5C3E45"
  },
  {
    "user_id": "u10",
    "code": "U5QXRQ"
  },
  {
    "user_id": "u11",
    "code": "8J4HNN"
  },
  {
    "user_id": "u12",
    "code": "JTP49P"
  },
  {
    "user_id": "u13",
    "code": "NGQETQ"
  },
  {
    "user_id": "u14",
    "code": "2YANKY"
  },
  {
    "user_id": "u15",
    "code": "AVYQTT"
  },
  {
    "user_id": "u16",
    "code": "JE3HGK"
  },
  {
    "user_id": "u17",
    "code": "JQYGNU"
  },
  {
    "user_id": "u18",
    "code": "CXVEDD"
  },
  {
    "user_id": "u19",
    "code": "WTRKUD"
  },
  {
    "user_id": "u20",
    "code": "W97YAV"
  },
  {
    "user_id": "o01",
    "code": "YCM2Y5"
  },
  {
    "user_id": "o02",
    "code": "BQEPH8"
  }
];
