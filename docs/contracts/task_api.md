# 작업·실행·제출 API 계약 초안

## 공통 규칙

API prefix `/v1`. opaque UUID, UTC RFC3339 시각, ISO 날짜, 보상은 부동소수점 없이 십진 문자열로 교환한다. 실제 정밀도/반올림은 지급표 검토 후 고정한다.
브라우저는 서버 세션, 기기는 Tokenisgold 기기 인증을 사용한다. provider credential을 요청 body에 받지 않는다. 기기 인증은 작업별 실행 권한을 대신하지 않는다.
모든 사용자 mutation은 `Idempotency-Key`를 받는다. `(actor_id, route, key)`와 정규화 body hash를 저장하고 같은 key/같은 body는 같은 결과, 다른 body는 409를 반환한다. API 재시도 보관기간과 원장의 영구 중복키 수명은 분리한다.
작업 변경은 `expectedVersion`, 수행자 실행 변경은 `claimId`, `claimGeneration`도 요구한다. 서버가 현재 상태/권한/버전을 검증한다. 요청자의 실행 대행·권한 상승은 클라이언트가 주장할 수 없다.
공통 오류: `{code, message, retryable, requestId}`. 401 인증, 403 권한, 404 접근 불가/없음, 409 상태/버전/중복 충돌, 422 범위/조건 오류, 503 일시 장애. 원시 provider 오류/키/상세 시스템 경로는 반환하지 않는다.

## 게시 TaskSpec

필수: `projectId`, `baseCommit`, `title`, `requestCategory`, `handoffArtifactId`, `scope`, `acceptanceChecks[]`, `aiRequirement`, `rewardTig`, `executionDeadlineAt`, `packageManifestHash`.
`aiRequirement`: 요청 원문과 정규화 `provider/tool/model/effort`, 지원 확인 상태/버전/관측 출처. 모르는 값을 임의 치환하지 않는다. 모델 식별 불가 시 명확한 대안을 받기 전 게시 조건 충족으로 표시하지 않는다.
`acceptanceChecks[]`: id, 설명, 필수 여부, 실행 환경/검사 종류, 성공 기준. 저장소에 테스트가 없어도 완료 기준은 필요하다. 클라이언트가 보낸 임의 shell 명령은 서버 웹 프로세스에서 실행하지 않는다.
패키지 manifest: 선택 경로·해시·크기·기준 commit·추적/미추적 출처·포함 승인 근거. symlink 탈출, 숨겨진 credential, 상위 경로 접근을 검사한다.
기본 24시간과 큰 작업별 기한은 게시 전에 절대 `executionDeadlineAt`으로 제시한다. 서버 접수 이후 자동 연장하지 않는다. 48시간 검토 기한과 별개다.

## endpoint와 actor

| Endpoint                          | actor                 | 주요 입력/출력·원자적 효과                                                                                                                         |
| --------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST /tasks                       | requester             | TaskSpec·명령 승인 근거 → task+version+escrow. 가용 잔액 차감/예치·OPEN·outbox를 한 transaction으로 처리                                           |
| GET /tasks / GET /tasks/{id}      | 허용된 사용자         | 마켓용 요약과 당사자 상세/원문 권한 분리. 기한·정산 결과·현재 version 반환                                                                         |
| POST /tasks/{id}/cancel           | requester             | 최초 수락 전 OPEN만 허용, 예치 전액 복구·REFUNDED                                                                                                  |
| GET /recommendations              | worker                | 명시적 추천 요청·최신 가용성 → 1개 추천+조건 일치 출처. 사용자 선언/관측 구분                                                                      |
| POST /tasks/{id}/claims           | worker                | 추천 작업의 Yes·expectedVersion → claimId/generation/startDueAt. 자기 작업 수락 제외는 남용 정책 검토 대상, 현재 endpoint 권한 계약에 명시 후 구현 |
| POST /claims/{id}/start           | 해당 기기/worker      | claim generation·expectedVersion → EXECUTING. 10분 시작 기한 확인                                                                                  |
| POST /claims/{id}/heartbeat       | 해당 기기/worker      | generation·순번·상태 관측 → 서버 수신 시각. 클라이언트 timestamp로 기한을 연장하지 않음                                                            |
| POST /claims/{id}/interrupt       | 해당 worker/내부 감지 | quota/offline/failure 관측 → INTERRUPTED·resumeDueAt=서버 기록+30분                                                                                |
| POST /claims/{id}/resume          | 해당 worker           | generation·version → EXECUTING, 전체 완료 기한 유지                                                                                                |
| POST /tasks/{id}/submissions      | 활성 worker           | claim generation·base/output commit·PR·내역서·검사 근거 → VALIDATING. 기한 만료/회수된 claim 제출 거부                                             |
| POST /tasks/{id}/approve          | requester             | 검토 중 version → PAID, 수락한 제출의 worker에게 전액·1회 지급                                                                                     |
| POST /tasks/{id}/issues           | requester             | 검토 중 문제 접수 → REFUNDED·전액 복구. 추가 증빙 심사를 필수화하지 않음                                                                           |
| POST /tasks/{id}/apply            | requester             | 제출/PR SHA·현재 원본 SHA → 병합 시도 결과. 승인/지급과 독립, 충돌이면 미반영/409. 실제 GitHub 최소 권한은 TH-003에서 확정                         |
| GET /wallet / GET /wallet/entries | 본인                  | 가용/예치/지급 이력. 내부 발행 계정 접근 불가                                                                                                      |
| POST /subscription-observations   | 본인 기기             | 허용된 플랜 metadata·출처/시각·도구 버전. 자기 신고 자체를 provider 증명으로 승격하지 않음                                                         |

기기 pairing/revoke·설정/삭제 endpoint는 데이터 계약을 따르며 실제 토큰 형식·CSRF·GitHub App scope는 별도 보안 명세가 필요하다.

## 클라이언트 헤더와 요청 레이아웃

CLI는 모든 요청에 `X-Tig-Client: tig/<version>`과 `X-Tig-Capabilities: request-tree`(공백·쉼표 구분 목록)를 보낸다. 브라우저와 구버전 CLI는 보내지 않으며, 서버는 이 헤더를 저장하지 않고 요청 처리에만 쓴다.
`TaskSpec.gitRequest`가 있는 요청의 `request.json`은 `layout`을 가질 수 있다(`bundle` | `tree`; 없으면 `bundle`, 기본값을 채워 넣지 않는다).

| layout              | 브랜치 내용                                                 | artifact               | 게시 검증                                                                                                                                 |
| ------------------- | ----------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle`(또는 없음) | `request.md`, `request.json`, `code/<선택 파일>`            | 문서 2개 + `code/*`    | 부모 없는 커밋, 재귀 tree == artifact 전수 비교(개수·경로·100644·sha1)                                                                    |
| `tree`              | 요청자의 작업 트리 전체 + 루트 `request.md`, `request.json` | 문서 2개만(정확히 2개) | 부모 없는 커밋, 루트 blob `request.md`/`request.json`이 100644이고 sha1이 artifact 내용과 같음(비재귀 tree 조회, 나머지 항목은 보지 않음) |

`POST /tasks/{id}/claim`: 작업의 artifact `request.json`이 `layout: "tree"`인데 요청에 `request-tree` capability가 없으면 409 `CLIENT_UPGRADE_REQUIRED`("Update tig to work on this request")로 claim 전에 거부한다. 작업은 OPEN, generation과 version은 그대로다.
`GET /tasks/{id}`: 당사자(requester/worker)에게만 `gitRequest{repository, branch, sourceCommit, requestPath}`와 `layout`(`bundle` | `tree`, artifact `request.json`에서 파생)을 함께 돌려준다. `gitRequest`가 없는 JSON 인계 작업에는 두 필드가 없다. `taskView` 스키마와 `requestUrl`은 바뀌지 않는다.

## 상태 전이와 시간 경계

OPEN → CLAIMED → EXECUTING → VALIDATING → AWAITING_REVIEW → PAID.
EXECUTING → INTERRUPTED → EXECUTING 또는 OPEN(1회 재추천); 환불은 REFUNDED terminal이다.
VALIDATING에서 필수 검사 실패는 기한 내 EXECUTING으로 돌아갈 수 있고, 기한 내 충족 불가면 REFUNDED다. 반복 검사 횟수 한도는 정책에서 정하지 않았으므로 임의 숫자를 넣지 않는다.
`reviewReadyAt`은 필수 검사 근거·artifact 접근 가능성을 서버가 확인한 시각, `reviewDueAt=reviewReadyAt+48h`. 내부 확인은 실제 모델 실행/기능 품질을 독립 증명했다는 의미가 아니다.
승인/문제 접수는 검토 기한 전에 접수된 요청만 정상 경로로 처리한다. 정확히 기한 시각이면 기한 만료가 우선하는 경계는 이 초안의 기술 제안이며 TH-003에서 UI와 함께 고정한다. 지급 후 신고는 별도 운영 경로다.
상태/원장 row lock과 version CAS, task당 settlement unique로 승인/환불/자동 지급 경쟁을 직렬화한다. API 실패/worker 재시도로 이중 이동이 일어나지 않는다.

## 실행 권한 회수

재추천은 이전 claim을 REVOKED로 하고 task generation을 증가시킨 뒤 OPEN으로 바꾼다. 이전 generation의 heartbeat/start/resume/submit은 거부한다.
서버 fencing은 늦은 제출을 차단할 뿐 오프라인 기기의 CPU/AI 사용을 직접 정지시키지 못한다. 로컬 실행 임대 만료 시 중단, 프로세스 그룹 종료, 네트워크/credential 경계는 별도 실제 검증이 필요하다.
기술 제안: heartbeat 15초, 60초 미수신에서 interrupted 관측. 30분 재개 유예는 승인 정책이다. 네트워크 단절시 해당 기기의 새 작업 실행은 금지하고 재연결 때 server generation을 먼저 확인한다.
전체 실행 기한이 먼저 만료되면 30분 유예/재추천이 기한을 연장하지 않는다. 재추천 1회가 소진됐거나 기한 내 완료되지 않으면 REFUNDED다.

## 성공 UX

“Your task is live.”는 예치와 OPEN 저장 성공 후만 표시한다.
“Submitted for review.”는 AWAITING_REVIEW 도달 후 표시한다. 업로드/필수 검사 검증 중에는 “Checking your submission.”
“Paid” / “Refunded”는 정산 transaction 완료 후 표시한다. 병합 실패가 지급을 자동 취소하지 않는다.
제출 결과 화면(승인이 곧 지급이다)은 제출이 실제로 담은 것만 가리킨다. `gitResult.pullRequestUrl`은 nullable이므로(`gh pr create` 실패 후 열린 PR도 없을 때 `null`) 값이 있을 때만 pull request를 말하고, 없으면 같은 줄이 이미 보여주는 결과 브랜치와 커밋(앞 7자리)을 이름으로 적는다. 없는 PR을 가리키지 않는다.
미러 안내 문구는 artifact의 `files`와 `deletedPaths`를 함께 본다. 파일이 `report.md` 하나뿐이어도 `deletedPaths`가 있으면 삭제 전용 결과이므로 “only report.md is mirrored here”라고 하지 않고 삭제 건수를 함께 적고 삭제 경로를 화면에 보여준다. 코드 파일이 미러된 보통 결과에는 문구를 붙이지 않는다.
