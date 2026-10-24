// 부대마다 다를 수 있는 기준 값을 모아 둔 곳.
// 여기 숫자만 바꾸고 저장하면 앱 전체에 반영된다. (바꾼 뒤 브라우저를 새로고침)

// 상점을 무엇으로 몇 점에 바꿔 주는가 (2026-10-24 사용자 확정)
// - reward: 포상휴가 1일 / overnight_pass: 포상 외박 1회 / outing_pass: 포상 외출 1회
export const MERIT_COSTS = {
  reward: 100,
  overnight_pass: 100,
  outing_pass: 50,
};

// 간부가 한 번에 줄 수 있는 상점·벌점의 최대 점수 (2026-10-24 사용자 확정)
export const MAX_POINTS_PER_ENTRY = 50;

// 외박·외출 횟수 제한 (2026-10-24 사용자 확정). 분기·한 달은 달력 기준(1~3월… / 1일~말일).
// - 외박은 토요일 출발 → 일요일 복귀(1박 2일)만
// - 한 분기에 외박 1회와 주말 외출 2회를 모두 쓸 수 있지만, 한 달에는 그중 1개만 쓴다 (2026-10-24 사용자 정정)
// - 포상 외박·외출로 쓴 것은 이 횟수에 들어가지 않는다
export const OVERNIGHT_PER_QUARTER = 1;
export const WEEKEND_OUTING_PER_QUARTER = 2;
export const WEEKDAY_OUTING_PER_MONTH = 2;
// 한 달에 쓸 수 있는 외박·주말 외출 (합쳐서)
export const WEEKEND_ABSENCE_PER_MONTH = 1;
