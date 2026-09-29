# 저장소·원장·주간 지급 계약 초안

PostgreSQL을 기준으로 한 테이블/제약 설계이며 실제 migration 또는 DB 검증 완료는 아니다.

## 엔터티

| table | 핵심 필드/제약 |
| --- | --- |
| users | id, github_user_id(unique), status, created_at, closed_at |
| devices | id, user_id, credential_hash, revoked_at, last_seen_at. 원문 token 저장 제외 |
| projects | id, github_repo_id(unique), public_visibility, owner, canonical_url, fork_parent_id, last_observed_at |
| project_links | user_id+project_id, linked_at, unlinked_at. 동일 기간의 이용률 분모 cohort 근거 |
| subscriptions | id, user_id, provider, provider_subject_ref(검증된 경우), plan_id, verification_state/source, observed_at, first_verified_at, next_due_at |
| plan_prices | provider+plan_id+effective_from, standard_monthly_usd, price_source_url, checked_at, weekly_grant_tig. 미확인 가격/세부 등급은 지급표에 추가하지 않음 |
| subscription_grants | subscription_id+period_index(unique), price_version, amount, issued_at, ledger_tx_id(unique) |
| tasks | requester/project/base_sha, scope/checks/requirement snapshots, reward, execution_deadline_at, state, version, generation, replacement_count, first_claimed_at, review_ready/due_at |
| claims | id, task_id, worker_id, device_id, generation, status, start_due_at, interrupted_at/resume_due_at. active claim은 task당·worker당 각각 unique partial index |
| submissions | id, task_id, claim_id/generation, base/output_sha, package/report refs, check_status/source, submitted_at, review_ready_at |
| settlements | task_id(unique), kind(paid/refunded), reason, amount, payee, submission_id, ledger_tx_id(unique), settled_at |
| ledger_accounts | user available, task escrow, system issuance. 사용자/escrow 잔액은 음수 불가 |
| ledger_transactions | id, business_key(unique), reason, created_at, idempotency_ref |
| ledger_entries | tx_id, account_id, signed_amount. tx별 합계=0, amount 정확한 십진수 |
| idempotency_requests | actor_id+route+key(unique), body_hash, result_ref, status |
| outbox | event_id(unique), aggregate_id/version, type, payload_allowlist, emitted_at/published_at. 상태/원장과 같은 transaction |

## 원장 불변식

주간 발행: system issuance -N / user available +N. 발행 계정만 음수 허용, 총 보유 증가를 발행 근거와 연결한다.
게시: requester available -N / task escrow +N. 게시/예치가 함께 성공하거나 함께 실패한다.
성공 지급: task escrow -N / worker available +N.
환불: task escrow -N / requester available +N. 새 발행으로 집계하지 않는다.
각 task escrow는 한 번 채워지고 전액 한 번 정산된다. 부분 지급·중복 환불·다른 task escrow 사용은 허용하지 않는다.
ledger entries는 append-only. 조정은 별도 근거 transaction이며 승인된 관리자 절차 없이 과거 row를 수정하지 않는다.
DB transaction 내부 account/task lock 순서를 고정해 deadlock을 줄이고 serialization/deadlock 실패는 같은 business key로 재시도한다. unique 제약과 aggregate version을 함께 사용한다.

## 주간 지급

각 provider의 최초 확인 시각이 자체 지급 주기의 기준이다. 0번째 주기를 즉시 지급하고 주기는 정확히 7일이다. 사용자 기기 시각 대신 서버 시각을 사용한다.
`period_index=floor((now-first_verified_at)/(7 days))`. 확인 복구 시 현재의 가장 최근 지급 가능 주기 1개만 지급하고 지난 미지급 주기는 발행하지 않는다. 이 해석은 P-051의 구현 초안이며 일시적 확인 공백 예시와 함께 검토한다.
플랜 변경은 다음 지급부터 적용하고 이미 지급한 주기를 추가 발행/회수하지 않는다. 해지 확인이면 다음 지급 중단·잔액 유지. 확인 불가는 해지와 분리하고 지급만 대기한다.
제공사별 개인 구독 1개와 동일 provider 계정의 여러 Tokenisgold 사용자 연결을 막기 위해 검증 가능한 안정 식별자가 필요하다. 이메일 hash만으로 소유권/실결제를 증명하지 않는다. 현재 이 provider 증명 경로는 미검증이다.
계정 탈퇴/재연결로 최초 지급을 반복하지 못하도록 주기/지급 이력과 최소 중복 방지 식별을 연결하는 설계가 필요하며 삭제 정책과 함께 검토한다.
TIG 정밀도: 금액은 SQL NUMERIC과 문자열을 사용한다. 표준 가격×50이 소수 TIG일 때의 표현/반올림을 아직 확정하지 않았으므로 지급표 승인 전 청구/발행하지 않는다.

## 필수 DB 통합 검증 목록

동시 게시 잔액 초과, approve/issue/deadline 3방향 경쟁, grant job 중복/재연결, publish tx 실패, outbox 중복 전송, revoke 후 늦은 제출, restore 후 원장 대사.
본 저장소의 상태 계약 검사만으로 PostgreSQL 동시성/원장 제약이 검증됐다고 표시하지 않는다. 실제 DB가 없는 환경에서 완료로 보고하지 않는다.
