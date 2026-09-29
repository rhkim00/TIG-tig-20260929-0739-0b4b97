# 기술 구조·DB·API

## 현재 기준

P-008: 웹+CLI 연동 구성을 확정했다. 정확한 스택·통신·상태 동기화 계약은 미정.
근거와 확정 결정은 [확정사항](00_confirmed.md)을 따른다. 아래 질문은 별도 결정 전까지 모두 미결정이다.

## 결정할 항목 — 미결정

| ID | 결정할 내용 | 선택지 또는 확인 사항 (예시) | 영향 |
| --- | --- | --- | --- |
| ARCH-01 | 언어·프레임워크·패키지 관리·버전 | Web/API/helper의 경계와 공통 언어 여부 | CLI+웹 확정 반영, AI-02 및 실행 흐름 이후 선정 |
| ARCH-02 | DB·캐시·queue·object storage 필요 범위 | 단순한 구성부터 필요한 기능에 맞춰 비교 | 배포 비용·개발 시간 |
| ARCH-03 | 핵심 schema와 API 계약 | users/tasks/claims/submissions/executions/ledger/reviews/installations | TASK/TIG/VER/SEC 결정 반영 |
| ARCH-04 | 비동기 작업과 진행 통신 | polling/SSE/WebSocket 후보, queue, lease, retry, webhook | 실패 복구·중복 처리 |
| ARCH-05 | AI 실행 위치와 비용 부담 | P-009: 현재 provider API 미도입. TaskSpec/결과 요약도 기존 사용자 도구로 처리할 경로·실패 UX 확정 | UX-01·VER-07, pooling 금지 유지 |
| ARCH-06 | 로컬 개발·CI·테스트·mock | 재현 가능한 실행 명령, env.example, 계약 테스트, 배포 검사 | TH-001~005 상세 분해 |
| ARCH-07 | 버전·migration·API 호환성 | 구버전 helper, DB migration rollback, breaking change | beta 업데이트와 서비스 연속성 |

## 자연어·매칭 흐름의 기술 요구

P-014~016: 기존 AI 연동 → 맥락 TaskSpec → 가용성 등록 → 조건 기반 추천 → Yes 승인 → Git 제출 → 평가·TIG 정산.
Git은 코드/인계물 버전 관리에 사용하며, task/claim/ledger/권한 상태의 원자성은 서버·DB 계약에서 설계한다.
연동·가용량 수집·평가 schema는 [FLOW 질문](13_agent_workflow.md)을 해결한 뒤 확정한다.

## 구현 순서 원칙

사용자 흐름과 Task/TIG 규칙을 먼저 계약으로 작성하고 Web mock과 서버가 같은 계약을 참조한다.
원본 entity 목록은 후보이며 실제 schema, 인증, 상태 전이, 멱등성 키까지 확정해야 구현 계약이 된다.
공통 root 설정·lockfile·타입을 두 사람이 동시에 수정하지 않도록 PLAN-03에서 담당을 결정한다.

## 결정 후 반영

관련 질문 ID에 확정 P-xxx를 연결하고, 동작·예외·완료 조건 및 영향받는 작업/계약을 갱신한다.

## 기술 방향 확정 — P-054

웹/서버/CLI 공통 언어는 TypeScript, 거래 DB는 PostgreSQL이다. 프레임워크·패키지·버전·배포 업체는 실제 호환/견적 후 구체화한다. DB 사용만으로 중복 정산이 방지되는 것은 아니므로 상태/원장 경합 계약을 작성한다.
승인 원문과 범위는 [결정 묶음 2](20_decision_batch_two.md) 및 [확정 기록](00_confirmed.md)을 따른다. 이전 질문 표의 중복된 미정 표현보다 이 결정이 우선한다.
