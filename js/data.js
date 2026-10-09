// 데이터 계층. 화면 코드는 가상 데이터를 직접 읽지 않고 이 파일의 함수만 쓴다.
// Phase 5에서 이 파일 안쪽만 Supabase로 바꿔 끼운다.
import { mockDb } from './mock-data.js';

// 로그인(1-2)을 만들기 전까지는 가상 병사 1번을 현재 사용자로 둔다.
let currentUserId = 'u01';

export function getCurrentUser() {
  const profile = mockDb.profiles.find((p) => p.id === currentUserId);
  return profile ? { ...profile } : null;
}
