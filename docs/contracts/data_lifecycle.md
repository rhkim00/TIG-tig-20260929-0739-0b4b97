# 이벤트·인사이트·보존/삭제 계약 초안

기준 P-057~066. 승인 기간을 이벤트/권한/삭제 작업으로 변환한다. 실제 처리 근거와 운영 문구 검토를 대체하지 않는다.

## 사건과 분석 객체

핵심 사건: task.published/recommended/claimed/started/interrupted/submitted/review_ready, settlement.paid/refunded, subscription.granted, project.linked/unlinked.
`event_id`, `task_id`, `submission_id`, `project_id`, 최소 user_ref, `occurred_at`, `received_at`, `source`, `schema_version`, `policy_version`, `purpose`, allowlist payload.
서버 원장/상태 사건을 authoritative로 표시하고 클라이언트 진단/모델 metadata는 client_observed/declared/unknown으로 구분한다. 사용자 입력 payload를 그대로 outbox에 복제하지 않는다.
`analytics.screen_view` 등 선택 행동 사건은 consent enabled가 확인된 경우에만 수집한다. 핵심 거래가 이 옵션에 의존하지 않는다. 설정 변경 후 SDK queue/서버 ingest 양쪽에서 재확인한다.
분류는 요청자 인계서에서 받아 분류 버전/수정 이력으로 저장한다. 분류 신뢰도가 낮으면 기타/미분류를 유지한다. 서버 유료 AI는 호출하지 않는다.

## 인사이트

일별 집계: request_category×project_type×stack의 게시 수·고유 요청자·수락/제출/직접 승인/자동 지급/환불. 코호트별 프로젝트 7/30일 재요청, 매칭 대기 중앙값/p90, TIG 발행/획득/소비.
유형별 이용률 numerator와 denominator는 동일 연결 프로젝트 cohort/기간을 사용한다. 연결 종료/이름 변경/fork와 관측 공백을 반영한다.
`metric_key, cohort, period_start/end, numerator, denominator, value, sample_size, missing_rate, classification_version, query_version, computed_at, lineage_ref`.
서술형 인사이트는 template/SQL 기반에서 시작하고 생성 주체/버전을 표시한다. 승인≠자동 지급≠검사 통과≠기능 품질이며 별도 지표다.
공개 endpoint는 서로 다른 요청자>=10 AND 작업>=30에 더해 희귀 조합 검토를 통과한 집계만 제공한다. 필터 세분화/기간 차분으로 작은 집단을 추출하지 못하도록 공개 쿼리 조합 제한을 설계한다.
내부 관리자와 본인 프로젝트 뷰를 분리한다. 공개 마켓의 코드 공개성과 분석상의 프로젝트 신원 공개를 혼동하지 않는다.

## 보존 시계

| 데이터 | 기산/만료 계약 |
| --- | --- |
| 플랫폼 코드 패키지 | 거래 종료 +90일. 원본 GitHub/PR 복제본 제외 |
| 게시 인계서·수행내역서·검사 요약 | 거래 종료 +1년 |
| 연결 가능한 분석 사건 | occurred_at +1년 |
| 마스킹 오류 로그 | 발생 +30일 |
| 일일 백업 | 생성 +30일 순환 |
| 정산 최소 가명 기록 | 활성 서비스 운영 중 보존, 계정 종료 +1년 기준. 직접 식별정보 별도 |
| 검토된 비식별 집계/인사이트 | 장기, 재식별/삭제 영향 재검토 |

개인별 삭제 요청은 일반 artifact TTL보다 우선한다. 원장에 필요하지 않은 코드/대화/메일을 붙이지 않는다. 거래 미종료 artifact가 무기한 남지 않도록 실행 기한/정산 terminal 작업을 검증한다.

## 설정·내보내기·삭제 API

GET/PATCH `/v1/me/data-settings`: optionalProductAnalytics 기본 false, policyVersion/changedAt 기록.
POST `/v1/me/exports`: 본인 범위만 비동기 export, API idempotency 적용. 짧은 만료 다운로드·재인증/권한 확인, 원시 credential/타인 정보 제외. URL 수명은 보안 계약에서 확정.
POST `/v1/me/deletion-requests`: 요청 접수 시 target scope·30일 dueAt·진행 거래 존재/정산 제한 반환. UI는 요청 접수를 삭제 완료로 표시하지 않는다.
삭제 job: identity mappings/artifacts/분석 원천/선택 이벤트/검색·캐시/파생 집계 영향을 처리하고 완료 증거를 남긴다. 익명성이 유지되는 집계를 무조건 삭제/무조건 영구 보존한다고 단정하지 않는다.
복원 시 tombstone/deletion journal을 적용한 뒤 서비스 재개한다. journal도 불필요한 식별정보를 담지 않고 원래 보존 목적을 넘지 않게 설계한다.
진행 작업/기존 잔액 처리에서 새 소각/환불 규칙을 임의 도입하지 않는다. 탈퇴 후 사용 불가 잔액 등 경계 사례는 실제 구현 전 기존 정책과 충돌 여부를 보고한다.

## 검증

opt-out 화면 사건이 저장되지 않음, core 사건 정상 기록, 재전송 중복 집계 없음, 공개 기준 미달/희귀 조합 차단, 다른 사용자의 export 거부, 삭제 후 백업 복원에서도 재노출 없음.
