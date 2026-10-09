// 가상 데이터 (Phase 0~4 전용)
// - 모든 이름과 일정은 지어낸 것이다. 실제 병사 정보를 넣지 않는다.
// - 표 이름은 prd.md 7번(Supabase 표 이름)과 같다. Phase 5에서 저장만 바꿔 끼운다.
// - 화면 코드는 이 파일을 직접 읽지 않고, 데이터 계층(Phase 1에서 만든다)을 거친다.
// - 비밀번호는 Supabase 인증이 따로 관리하므로 profiles에 넣지 않는다.
//
// 값의 뜻
// - profiles.role: soldier(병사), officer(간부)
// - events.type: personal(개인), duty(근무), unit(부대), leave(휴가), overnight(외박), outing(외출)
// - events.unit_category: training(훈련), inspection(점검), event(행사), other(기타)
//   훈련은 제목과 설명 없이 "훈련"으로만 표시하므로 title을 비워 둔다.
// - facilities의 운영 시간은 아직 정해지지 않아 임시 값이다 (prd.md 11번).

export const mockDb = {
  "profiles": [
    {
      "id": "u01",
      "name": "김하늘",
      "username": "soldier01",
      "role": "soldier",
      "company": "1중대",
      "enlist_date": "2025-05-04",
      "discharge_date": "2026-11-03",
      "is_active": true
    },
    {
      "id": "u02",
      "name": "이바다",
      "username": "soldier02",
      "role": "soldier",
      "company": "2중대",
      "enlist_date": "2025-05-29",
      "discharge_date": "2026-11-28",
      "is_active": true
    },
    {
      "id": "u03",
      "name": "박가온",
      "username": "soldier03",
      "role": "soldier",
      "company": "3중대",
      "enlist_date": "2025-06-23",
      "discharge_date": "2026-12-22",
      "is_active": true
    },
    {
      "id": "u04",
      "name": "최나래",
      "username": "soldier04",
      "role": "soldier",
      "company": "1중대",
      "enlist_date": "2025-07-18",
      "discharge_date": "2027-01-17",
      "is_active": true
    },
    {
      "id": "u05",
      "name": "정다온",
      "username": "soldier05",
      "role": "soldier",
      "company": "2중대",
      "enlist_date": "2025-08-12",
      "discharge_date": "2027-02-11",
      "is_active": true
    },
    {
      "id": "u06",
      "name": "강보람",
      "username": "soldier06",
      "role": "soldier",
      "company": "3중대",
      "enlist_date": "2025-09-06",
      "discharge_date": "2027-03-05",
      "is_active": true
    },
    {
      "id": "u07",
      "name": "조새벽",
      "username": "soldier07",
      "role": "soldier",
      "company": "1중대",
      "enlist_date": "2025-10-01",
      "discharge_date": "2027-03-31",
      "is_active": true
    },
    {
      "id": "u08",
      "name": "윤겨울",
      "username": "soldier08",
      "role": "soldier",
      "company": "2중대",
      "enlist_date": "2025-10-26",
      "discharge_date": "2027-04-25",
      "is_active": true
    },
    {
      "id": "u09",
      "name": "장한결",
      "username": "soldier09",
      "role": "soldier",
      "company": "3중대",
      "enlist_date": "2025-11-20",
      "discharge_date": "2027-05-19",
      "is_active": true
    },
    {
      "id": "u10",
      "name": "임도담",
      "username": "soldier10",
      "role": "soldier",
      "company": "1중대",
      "enlist_date": "2025-12-15",
      "discharge_date": "2027-06-14",
      "is_active": true
    },
    {
      "id": "u11",
      "name": "한마루",
      "username": "soldier11",
      "role": "soldier",
      "company": "2중대",
      "enlist_date": "2026-01-09",
      "discharge_date": "2027-07-08",
      "is_active": true
    },
    {
      "id": "u12",
      "name": "오여름",
      "username": "soldier12",
      "role": "soldier",
      "company": "3중대",
      "enlist_date": "2026-02-03",
      "discharge_date": "2027-08-02",
      "is_active": true
    },
    {
      "id": "u13",
      "name": "서누리",
      "username": "soldier13",
      "role": "soldier",
      "company": "1중대",
      "enlist_date": "2026-02-28",
      "discharge_date": "2027-08-27",
      "is_active": true
    },
    {
      "id": "u14",
      "name": "신다솜",
      "username": "soldier14",
      "role": "soldier",
      "company": "2중대",
      "enlist_date": "2026-03-25",
      "discharge_date": "2027-09-24",
      "is_active": true
    },
    {
      "id": "u15",
      "name": "권별하",
      "username": "soldier15",
      "role": "soldier",
      "company": "3중대",
      "enlist_date": "2026-04-19",
      "discharge_date": "2027-10-18",
      "is_active": true
    },
    {
      "id": "u16",
      "name": "황이랑",
      "username": "soldier16",
      "role": "soldier",
      "company": "1중대",
      "enlist_date": "2026-05-14",
      "discharge_date": "2027-11-13",
      "is_active": true
    },
    {
      "id": "u17",
      "name": "안소울",
      "username": "soldier17",
      "role": "soldier",
      "company": "2중대",
      "enlist_date": "2026-06-08",
      "discharge_date": "2027-12-07",
      "is_active": true
    },
    {
      "id": "u18",
      "name": "송하람",
      "username": "soldier18",
      "role": "soldier",
      "company": "3중대",
      "enlist_date": "2026-07-03",
      "discharge_date": "2028-01-02",
      "is_active": true
    },
    {
      "id": "u19",
      "name": "전가람",
      "username": "soldier19",
      "role": "soldier",
      "company": "1중대",
      "enlist_date": "2026-07-28",
      "discharge_date": "2028-01-27",
      "is_active": true
    },
    {
      "id": "u20",
      "name": "홍새롬",
      "username": "soldier20",
      "role": "soldier",
      "company": "2중대",
      "enlist_date": "2026-08-22",
      "discharge_date": "2028-02-21",
      "is_active": true
    },
    {
      "id": "o01",
      "name": "백지훈",
      "username": "officer01",
      "role": "officer",
      "company": "본부",
      "enlist_date": "2019-03-04",
      "discharge_date": "2029-02-28",
      "is_active": true
    },
    {
      "id": "o02",
      "name": "남궁현",
      "username": "officer02",
      "role": "officer",
      "company": "본부",
      "enlist_date": "2021-06-14",
      "discharge_date": "2027-06-30",
      "is_active": true
    }
  ],
  "invite_codes": [],
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
    }
  ],
  "leave_grants": [],
  "leave_requests": [],
  "leave_request_items": [],
  "leave_settings": [],
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

// 로그인 흉내용 비밀번호 (Phase 0~4 전용)
// - Supabase 인증 기능을 흉내 낸다. Phase 5에서는 Supabase가 비밀번호를 해시로 따로 관리하므로 이 목록을 지운다.
// - 가상 계정 전용 연습 비밀번호다. 실제 비밀번호를 넣지 않는다.
export const mockAuth = [
  {
    "user_id": "u01",
    "password": "test1234"
  },
  {
    "user_id": "u02",
    "password": "test1234"
  },
  {
    "user_id": "u03",
    "password": "test1234"
  },
  {
    "user_id": "u04",
    "password": "test1234"
  },
  {
    "user_id": "u05",
    "password": "test1234"
  },
  {
    "user_id": "u06",
    "password": "test1234"
  },
  {
    "user_id": "u07",
    "password": "test1234"
  },
  {
    "user_id": "u08",
    "password": "test1234"
  },
  {
    "user_id": "u09",
    "password": "test1234"
  },
  {
    "user_id": "u10",
    "password": "test1234"
  },
  {
    "user_id": "u11",
    "password": "test1234"
  },
  {
    "user_id": "u12",
    "password": "test1234"
  },
  {
    "user_id": "u13",
    "password": "test1234"
  },
  {
    "user_id": "u14",
    "password": "test1234"
  },
  {
    "user_id": "u15",
    "password": "test1234"
  },
  {
    "user_id": "u16",
    "password": "test1234"
  },
  {
    "user_id": "u17",
    "password": "test1234"
  },
  {
    "user_id": "u18",
    "password": "test1234"
  },
  {
    "user_id": "u19",
    "password": "test1234"
  },
  {
    "user_id": "u20",
    "password": "test1234"
  },
  {
    "user_id": "o01",
    "password": "test1234"
  },
  {
    "user_id": "o02",
    "password": "test1234"
  }
];
