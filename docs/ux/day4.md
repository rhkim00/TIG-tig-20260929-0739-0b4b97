# 초기 영어 웹 UX 구현

TH-027에서 초기 화면을 선행 구현했다. 륜호는 TH-002/004/008/011을 새로 만들기 전에 이 코드와 검증 결과를 리뷰한다.

| 화면 | 구현과 상태 |
|---|---|
| 첫 방문 | 가치 설명, GitHub 로그인, 기본 수집 안내. OAuth 설정 없으면 미설정 안내. 개발 mode만 샘플 계정 버튼 |
| Overview | 실제 DB 가용/예치 TIG, active task 수, 로컬 인계 안내, AI 연결 출처, 공개 작업 카드 |
| Marketplace | 공개 작업 검색·상세. 수락/실행은 아직 비활성 |
| My tasks | 본인 게시 상태·기한·보상, OPEN 취소 후 전액 복구 |
| Post dialog | 저장 인계서 가져오기, 프로젝트/범위/검사/도구/모델/추론/보상/기한, 실제 API 게시 |
| Connections | CLI 연결 코드 승인, 기기 해제, 공개 GitHub 프로젝트 연결, 플랜 관측과 실제 지급 자격 구분 |
| Activity | DB 원장 이동·예치/환불·개발 샘플 발행 내역 |
| Settings | 선택 분석 기본 off, API 저장/실패 복구. export/delete/결과 정산은 후속 범위 |

반응형 sidebar, 키보드 가능한 native dialog, 폼 labels, 상태 알림, 제출 중 중복 클릭 방지, 서버 오류 표시와 재시도를 포함한다.
웹은 10초 간격으로 조회하고 숨긴 탭에서는 polling을 쉬므로 CLI 게시/취소가 같은 DB 상태로 반영된다. 푸시 방식 동기화는 TH-019 후속이다.

UX 예시: 기존 AI에서 “Post this task for 1,000 TIG.” → 로컬 handoff와 명세로 CLI 게시 → 웹 My tasks에서 같은 작업과 예치 확인 → 수락 전 Cancel task → TIG 전액 복구.
모델/사용량 unknown·client_observed를 verified로 꾸미지 않는다. 샘플 계정/잔액/작업은 개발 전용 배너로 표시한다.

륜호 다음 리뷰: 문구/누락 상태/게시 흐름 클릭 수/모바일 입력, 구독 확인 불가 안내, 결과·48시간·환불 화면으로 이어지는 구조.
