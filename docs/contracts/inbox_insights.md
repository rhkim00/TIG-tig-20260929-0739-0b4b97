# TH-031 알림·개인 인사이트·결과 다운로드 계약

P-046, P-057~066의 범위에서 구현한다. 제공사 실행/구독 검증 또는 이메일 발송 설정과 독립적이다. 공통 스키마는 `packages/contracts/src/insights.ts`, 경로는 `/v1/openapi.json`에도 등록했다.

## 알림함

- GET `/v1/notifications`: 인증한 사람의 최근 50개와 전체 unreadCount, nextCursor. 다음 페이지는 `?before=<ISO>&beforeId=<UUID>` 두 값을 함께 전달한다. created_at과 id 내림차순으로 동시각 알림도 중복/누락 없이 조회한다.
- POST `/v1/notifications/:id/read`: `{}`와 Idempotency-Key. 본인 알림에만 read_at을 최초 한 번 저장한다. 다른 사람의 ID는 404, 반복 호출은 같은 읽음 상태.
- notification 필드: id, taskId, type, title, body, createdAt, readAt(null 가능).
- Worker가 outbox를 소비하며 task.claimed/submitted는 요청자에게, settlement.paid/refunded는 거래 양쪽에, task.reopened는 요청자와 회수된 수행자에게 알린다. 공개 마켓 목록과 알림 수신은 별개다. 회수된 수행자는 최신 작업 상세 접근을 잃을 수 있으며 알림 자체를 읽음 처리할 수 있다.
- 알림마다 `(user_id,business_key=event_id)` unique. outbox 전달 완료·운영 사건 기록·알림 삽입은 같은 트랜잭션이다. 재시도/재전달해도 읽음 상태를 덮어쓰지 않는다.
- 핵심 정산은 별도 트랜잭션에서 먼저 완료한다. 알림/집계 실패가 이미 처리한 지급을 되돌리지 않는다. 실패한 전달은 다음 tick에 재시도한다.
- 본인 알림 문구는 일반 상태/금액만 포함한다. 원문 코드/AI 대화/인증 credential을 알림에 넣지 않는다. 연결 가능한 개인 거래 알림은 1년 후 정리한다.
- 웹 Inbox는 보이는 동안 3초 주기로 갱신한다. 네비게이션의 미확인 수는 기존 dashboard 주기를 따른다. 이메일 발송/임박 알림 스케줄·수신 설정은 별도 후속이다.

## 일일 개인 인사이트

GET `/v1/insights?segment=real` → `{pending,report}`. userId를 클라이언트에서 받지 않으며 본인 보고서만 반환한다. 실적의 기본 segment는 real이고 개발용 fixture/`dev:` 프로젝트는 제외한다. 일반 계정은 다른 사용자나 운영자 상세를 이 경로로 조회할 수 없다.

Worker는 UTC 하루에 사용자/segment/queryVersion별 snapshot을 한 번 생성한다. 같은 날 재시작/재실행은 중복 생성하지 않는다. 한 tick당 최대 20개의 누락 보고서를 처리하고 다음 tick에서 이어간다. 관측 종료 시각은 해당일 00:00 UTC, 구간은 `[종료-30일,종료)`다. 당일 신규 활동은 다음날 포함된다. 보고서가 아직 없으면 pending=true. 최신 보고서의 generatedAt/windowEnd를 표시하므로 오래된 보고서를 오늘 자료라고 표현하지 않는다.

개발 환경에서는 `/v1/insights?segment=development&preview=true`로 현재 시각까지의 샘플을 직접 집계한다. mode=preview, 별도 표시, 영구 일일 snapshot을 덮어쓰지 않는다. 실제 실적 segment 또는 운영 모드에서 실시간 preview를 요구하면 403이다.

| 지표 | 정의 |
|---|---|
| requestedTasks/categories | 본인이 구간 안에 게시한 작업 수와 요청 카테고리별 건수. 분모는 같은 기간 본인 게시 수 |
| projects | 본인의 프로젝트별 해당 기간 게시 수. 프로젝트 이름·유형은 본인 보고서 안에서만 노출 |
| activeConnectedProjects / connectedProjects | 보고서 생성 시점에 연결된 프로젝트 중 기간 내 본인이 게시한 프로젝트 수 / 생성 시점 현재 연결된 프로젝트 수. 기간 내 과거 연결 상태를 완전히 재구성한 값이나 GitHub 시장 점유율이 아님 |
| directApprovals | 기간 내 정산된 본인 요청 중 requester_approved |
| automaticPayments | 기간 내 정산된 본인 요청 중 review_timeout. 품질 승인으로 합산하지 않음 |
| refunds | 기간 내 본인 요청의 전액 환불 정산 |
| paidTig/refundedTig | 위 기간 내 본인 요청 정산의 지급/복구액 |
| earnedTig | 수행자로서 기간 내 지급받은 TIG. 본인 요청 지출과 별개 |

게시 집계와 정산 집계는 각자의 발생 시각 기준이다. 이전에 게시된 작업이 지금 정산될 수 있으므로 둘을 같은 코호트의 성공률로 나누지 않는다. 카테고리는 검증된 enum의 요청자 입력이며 별도 AI 분류 정확도를 주장하지 않는다. TIG는 PostgreSQL의 정확한 decimal 합계를 문자열로 전송한다.

snapshot은 기간/생성 시각/segment/schemaVersion/queryVersion/분자·분모·coverage를 저장한다. 근거는 tasks, settlements, projects, project_links의 관측 가능한 거래 기록이다. 생성 당시 DB에 커밋되어 조회 가능한 자료가 대상이며 늦게 관측된 사건은 후속 보고서에 반영된다. 사용자와 연결된 집계이므로 1년 후 정리하고 비식별 공개 집계처럼 무기한 보존하지 않는다.

현재 API는 개인 지표에 한정한다. 관리자 RBAC 상세 분석, 공개 통계의 10명/30건+재식별 위험 검토, 분류 수정 이력, 다양한 코호트·난이도/실행시간/모델 비교와 원천 삭제 연동은 후속이다. 자동 지급에 qualityScore를 만들지 않고 null을 유지한다.

## 결과 다운로드

GET `/v1/tasks/:id/result`: 요청자 또는 현재 수행자의 제출 결과만 내려준다. 제출 전/권한 없음은 404. 응답은 attachment JSON이며 `{schemaVersion,taskId,report,checks,execution,artifact}`. artifact는 기존 baseCommit/summary/files/deletedPaths/manifestHash 계약과 동일하다.

웹 Download result와 `tig result <id> --output <new-file.json>`이 같은 API를 쓴다. CLI는 새 파일만 0600으로 생성하며 기존 파일·심볼릭 링크를 덮어쓰지 않는다. 파일을 자동 실행/사용자 저장소에 적용하지 않는다. Git PR 생성·Apply changes는 별도 구현과 명시적 사용자 동의가 필요하다. 개발 fixture의 execution.providerVerified=false도 그대로 전달한다.
