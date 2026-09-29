# TH-031 — 알림·개인 인사이트·결과 검토 구현

2026-09-09, timeistoken 세션. 사용자의 다음 개발/륜호 웹 영역 진행 승인. [PR #6](https://github.com/timeistoken/TaskHub/pull/6), 기준 PR #5. 최종 리뷰/main 병합 전 REVIEW다.

## 이번 결과

- Worker outbox 기반 사용자별 알림함, 읽음/미확인/페이지 커서, 웹에서 결과 검토로 바로 이동. 재전달 시 중복 및 읽음 초기화 방지.
- 본인의 최근 30일 요청 종류/프로젝트·직접 승인/자동 지급/환불/TIG SQL 집계, 사용자별 UTC 일일 snapshot. 실제 실적과 개발 샘플 분리, 개발 환경의 실시간 샘플 미리보기.
- 코드 내용·수행내역·검사 출처가 포함된 결과 JSON 다운로드. 웹과 CLI 같은 API, 참여자만 조회, 기존 파일 덮어쓰기/자동 적용/실행 없음.
- 웹 Inbox/Insights, 모바일 배치/검토 버튼·다운로드, CLI 0.2.0 inbox/read/insights/result 명령과 설치본 갱신.
- 금융 정산을 알림 전달/집계 트랜잭션과 분리하여 집계 장애에도 지급이 유지되도록 처리.

## 검증

| 명령/검사 | 실제 결과 |
|---|---|
| npm run build | TypeScript/Vite 빌드 통과 |
| npm run cli:install | tokenisgold-cli-0.2.0.tgz 생성 및 ~/.local/bin/tig 업데이트 |
| TIG_TEST_CLI=<설치된 main.js> npm test | 34개 통과. 실제 PostgreSQL 고유 schema, 설치된 CLI 제출/알림/결과 다운로드/덮어쓰기 거부/개인 집계 포함 |
| npm run test:e2e | desktop/mobile 4개 통과. 실제 Worker와 두 계정으로 Inbox→검토→다운로드→지급 또는 환불→Insights 확인. 기존 게시/취소/개인정보 설정 회귀 포함 |
| 화면 확인 | insights desktop/mobile 스크린샷 직접 확인 후 checkbox 배치·막대 색·단수 표기를 보완 |
| 개발 서버 smoke | migration 004/005 적용, localhost:4173의 Inbox/Insights/샘플 미리보기 확인, CLI 0.2.0 확인 |
| 협업 검사 | workspace/DAG/정적 계약, team 도구 7개와 diff --check 통과 |
| tig doctor | 실행 검사 실패 재확인: available=false, executionEnabled=false. 실제 AI runner 검증 통과 아님 |

추가 검증 대상: 다른 사용자 알림/집계/결과 접근 차단, 같은 시각 알림의 페이지 경계, outbox 재전달, 일일 보고서 중복/당일 제외/다음 UTC 일자 갱신, 자동 지급과 직접 승인 분리, 집계 실패 시 자동 지급의 commit 유지. 테스트는 자기 schema만 정리하며 수동 테스트 DB를 초기화하지 않는다.

첫 E2E에서 알림의 비동기 전달과 화면 갱신 주기 사이의 대기 차이를 확인했다. 열린 Inbox의 갱신을 3초로 설정하고 테스트는 실제 전달/갱신을 기다리도록 수정한 뒤 통과했다. 이메일 전송/제공사 AI 호출은 테스트하지 않았고 활성화하지 않았다.

## 범위와 후속

인사이트는 본인의 거래/프로젝트에 한정한다. 생성 시점 현재 연결된 프로젝트를 분모로 쓰며, 과거 연결 상태 전체·GitHub 시장 점유율·코드 품질 점수로 표현하지 않는다. 샘플을 실제 실적에 넣지 않는다. 사용자 연결 snapshot/알림 1년 정리는 구현했지만 전체 원천/코드 보존·삭제 요청·내보내기/복원 후 삭제까지 완료한 것은 아니다.

실제 AI runner·격리/자원/권한/모델 조건 검증, 신뢰 가능한 구독 확인·외부 OAuth, 추천/실제 Git PR/Apply changes, 이메일, 전체 데이터 권리/보존, 관리자·공개 집계, 외부 배포/복구가 남는다. 이번 문서/UX가 제공사 허용이나 공개 출시의 증거는 아니다.

웹 변경은 륜호가 작업하기 전에 TH-031에서 가져온다. 륜호 브랜치와 체크아웃을 덮어쓰지 않았다. 다음 세부 배정/순서는 [NOW](../coordination/NOW.md), 실행은 [TRY_TOGETHER](../TRY_TOGETHER.md).
