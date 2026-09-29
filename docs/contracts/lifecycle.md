# TH-029 거래 API 계약

기준: P-047~050, P-066 및 요청자의 두 계정/CLI 테스트 지시. 소비자: TH-030 웹, CLI. 공통 타입은 `packages/contracts/src/{index,lifecycle}.ts`, 공개 스키마는 `/v1/openapi.json`.
이 구현에서 수락/실행/제출은 **개발 모드의 fixture와 Git 요청(`spec.gitRequest`)에 활성화**한다. Git 요청의 제출은 "local trial"로 기록한다: 서버는 패키지 경로/해시/크기만 검증하고, 런타임 테스트·인수 조건은 `not_run`, 실행 provider/model은 `client_observed`·`providerVerified:false`로 저장한다. 파일은 `code/` 하위(및 선택적 `report.md`)만 허용한다. 선택 필드 `gitResult {repository, branch tig/results/<taskId>, commit, pullRequestUrl}`가 오면 서버는 저장 전에 저장소가 공개인지와 커밋이 실재하는지 GitHub로 확인하고 `commitVerified: "server_verified"`로 기록한다(내용 일치는 검증하지 않는다). 요청자는 파일과 수행내역을 보고 승인/문제 접수하며 48시간 규칙은 동일하다. JSON 인계 방식의 일반 작업은 여전히 `RUNNER_NOT_READY`로 수락을 막는다. Git 요청의 local trial 수락/제출은 개발 모드에서 항상 켜지고, 그 밖의 환경에서는 `TIG_LOCAL_TRIAL=true`를 명시할 때만 켜진다(기본 off — 격리 실행이 검증되기 전까지 공개 서비스에서 켜지 않는다). `GET /v1/config`의 `localTrialSubmission`이 현재 값을 알려준다. 모델·플랜 기반 실제 추천과 공식 AI 실행·Git PR 제출은 후속이다. 개발 성공을 실제 제공사/모델 실행 증명으로 집계하지 않는다.

## 인증·동시성

기존 cookie+정확한 Origin 또는 연결된 기기의 Bearer 인증. POST마다 Idempotency-Key(8~128자). 모든 작업 변경은 expectedVersion을 요구하며 시작/재개/heartbeat/중단/제출은 generation도 요구한다. version은 성공한 상태 변경마다 증가한다. generation은 새로운 수락마다 증가한다. 회수된 수행자의 오래된 결과는 거절한다.
같은 Idempotency-Key/같은 body는 최초 결과를 재전달하며 다른 body는 409. 동일 작업 행 잠금·수행자별 수락 잠금·활성 수행자 unique index로 중복을 막는다. 원장/settlement/outbox가 한 트랜잭션이며 업무 키 `task:<id>:settlement`와 settlements PK로 최종 정산은 한 번이다.

## 경로

| 경로 | Body | 결과 |
|---|---|---|
| POST /v1/dev/tasks | `{rewardTig:"100"}` | 로컬 wallet-labels fixture 게시/예치. 0 초과 3000 이하, 개발에서만 존재 |
| GET /v1/tasks?mine=true | 없음 | 내가 요청했거나 수행한 최근 100개 |
| GET /v1/tasks/:id | 없음 | Task와 참여자에게만 artifacts/submission. OPEN 일반 작업의 비공개 scope는 공개하지 않음. 고정 개발 fixture의 scope/checks는 공개 |
| POST /v1/tasks/:id/claim | `{expectedVersion:1,consent:"accept_this_task"}` | OPEN→CLAIMED; 내 작업 불가, 수행자 동시 실행 1개 |
| POST /v1/tasks/:id/start | `{expectedVersion:2,generation:1}` | CLAIMED→EXECUTING |
| POST /v1/tasks/:id/heartbeat | 같은 형식 | EXECUTING 유지, 실행 유효기간 30분 갱신 |
| POST /v1/tasks/:id/interrupt | 같은 형식 | EXECUTING→INTERRUPTED, 30분 재개 유예 |
| POST /v1/tasks/:id/resume | 같은 형식 | INTERRUPTED→EXECUTING |
| POST /v1/tasks/:id/submit | 아래 참조 | 서버 fixture 필수 검사 후 AWAITING_REVIEW |
| POST /v1/tasks/:id/approve | `{expectedVersion:4}` | 요청자만 PAID, 전액 수행자 지급 |
| POST /v1/tasks/:id/issue | `{expectedVersion:4}` | 검토 기한 전 요청자만 REFUNDED, 전액 복구·종료 |

Task 기존 필드에 workerId(null 허용), generation, phaseDueAt(null 허용), reviewDueAt(null 허용), developmentFixture를 추가했다. 상세 화면은 갱신 후 받은 version을 쓴다. 409는 새 상세를 조회하며, 사용자 의사를 바꿔 자동 재수락/재정산하지 않는다.

submit Body:

```json
{
  "expectedVersion": 3,
  "generation": 1,
  "report": "Updated the wallet labels. No AI was called.",
  "artifact": {
    "baseCommit": "dddddddddddddddddddddddddddddddddddddddd",
    "summary": "Updated the requested wallet labels.",
    "files": [{"path":"wallet-labels.json","content":"<JSON text>","sha256":"<sha256 of content>","source":"tracked"}],
    "deletedPaths": [],
    "manifestHash": "<canonical manifest SHA256>"
  }
}
```

hash 규칙/크기/비밀 검사는 기존 artifact 계약과 같다. 예시의 hash placeholder를 실제 계산한 값으로 교체해야 한다. fixture JSON은 아래 세 key/value와 정확히 일치해야 하며 코드 실행 없이 JSON 파싱/strict schema로 검사한다. 고객 파일을 eval/shell 실행하지 않는다.

```json
{"available":"Available TIG","escrow":"Reserved TIG","paid":"Reward paid"}
```

실패는 422 CHECKS_FAILED, 상태/예치/제출시각 유지, 실행 기한 안에 수정 가능. 통과 시 업로드 파일과 report, 검사 provenance, `execution:{kind:"development_fixture",providerVerified:false}`를 저장한다. 참여자에게 파일이 조회 가능해지는 동일 커밋의 submitted_at부터 48시간을 계산한다. 자동 지급은 코드 품질/모델 확인 성공 지표가 아니다.

## Worker 시계와 종료

- 시작 기한: 수락 시각 +10분. 미시작은 OPEN으로 해제하며 실행 교체 횟수에 포함하지 않는다.
- 실행 heartbeat/명시적 중단: 마지막 진행 신호 +30분. 만료 시 OPEN으로 1회 재개방, 다음 실행 중단은 전액 환불. 원래 전체 실행 기한 유지.
- 전체 실행 기한이 먼저 만료되면 전액 환불. 검토 상태가 된 뒤에는 실행 기한 대신 review_due_at을 사용한다.
- 검토 시작 +48시간 전에는 요청자 approve/issue 중 먼저 성공한 정산이 유효하다. 정확히 기한부터 review_timeout 지급이 우선한다. 같은 시간의 요청/Worker 경합도 행 잠금 아래 한 번 정산한다.
- 승인과 Git 변경 적용은 별개다. 이 fixture는 결과 파일을 웹에 보여주며 외부 PR 생성/병합은 하지 않는다.

핵심 오류: 401 인증, 403 Origin, 404 소유권/참여 권한, 409 TASK_CHANGED/OWN_TASK/WORKER_BUSY/CLAIM_EXPIRED/REVIEW_CLOSED, 422 CHECKS_FAILED/INVALID_INPUT, 503 RUNNER_NOT_READY.

원천 사건: task.claimed/start/heartbeat/interrupt/resume/reopened/submitted, settlement.paid/refunded. 제출에 종류/projectId/게시부터 제출까지 elapsedMs/실행 종류를 붙이며 outbox→operational_events 중복 방지. 실제 AI 실행 시간이나 난이도 점수로 추정하지 않는다. 장기 데이터 보존·삭제·집계 및 이메일 전송은 아직 후속이다.
