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
