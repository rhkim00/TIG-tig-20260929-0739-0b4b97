# TH-027 Day 1~4 구현 보고

기준: 2026-09-09 사용자의 즉시 구현 요청. 선행 설계 51ef2e2. 코드/검증은 [PR #3](https://github.com/timeistoken/TaskHub/pull/3)의 최신 head를 따른다.
실행 방법: [DEVELOPMENT](../DEVELOPMENT.md). 구현 계약: [day4](../contracts/day4.md). 화면: [UX](../ux/day4.md).

## 산출물과 원래 노드 연결

| 원래 작업 | 실제 구현 | 남은 조건 |
|---|---|---|
| 001·003·006 | Node24/TypeScript 모노레포, 공통 Zod 스키마/OpenAPI, SQL migration, CI/개발환경 | 전체 실행·정산 API 계약은 후속, 스택 최종 리뷰 |
| 002·004·008 | 영어 가입/홈/연결/잔액/상태 UI, 모바일 레이아웃·오류/재시도 | 륜호 UX 리뷰, 실제 OAuth/onboarding 검증 |
| 005 | API/PostgreSQL/Worker, transactional outbox→운영 사건, 재시도, health | 배포/분산 관측·전체 후속 job |
| 007 | GitHub OAuth state/PKCE, 세션·CSRF, 코드 pairing/기기 해제, 공개 repo 연결, Codex 공식 metadata allowlist | 실제 OAuth App 등록; provider 고유 구독/결제 자격 검증; Claude 자동 관측 |
| 009 | 정확한 TIG 원장, 예치/환불, 7일 지급 엔진·기간 중복 방지·복구 최신 1회·해지/조회 실패/변경 | 실제 가격표·신뢰한 구독 검증자 연결. 현재 production 지급 자격 발급 경로 없음 |
| 010 | 로컬 checkpoint/watch/export, tracked·미커밋·삭제 목록·승인 untracked, 경로/비밀 제외, CLI/웹 게시+예치 | 양 AI 응답 hook 자동 설치, 대형 패키지 저장소/한도 확장 검토, fallback 요약 실행 |
| 011 | 실제 마켓 검색/작업 상세/본인 작업/취소 화면 | 적합 1건 추천·Yes·진행 UI와 실제 매칭은 TH-012~016 |
| 013 | Linux namespace 진단, 실행 미지원/실패 시 비활성, 무격리 대체 실행 없음 | 실제 안전한 runner·credential broker·자원 제한과 OS별 검증. 완료로 표시하지 않음 |

기존 TH 노드 전체를 DONE 처리하지 않았다. 이번 통합 구현은 별도 TH-027로 리뷰하며 기존 선행/정책 PR 병합은 유찬 결정이다.

## 검증 증거

- 실제 PostgreSQL 16.15: 인증/CSRF, 단일-use OAuth state+PKCE(합성 GitHub transport), pairing 발급 경합·즉시 해제, strict metadata 입력.
- 실제 PostgreSQL: 동일 게시 10회 병렬 재시도, 별도 게시 동시 잔액 초과, outbox 오류 주입 시 전체 rollback, 취소 권한/버전/전액 환불, 원장 변조·불균형 차단.
- 시간 제어한 실제 DB: 첫 주간 지급·동시 job·별도 provider anchor·최신 미지급 1회·가격 변경 다음 주기·검증 실패/만료/해지·미수락 작업 기한 환불·outbox 중복 소비 방지.
- CLI: 실제 임시 Git 저장소의 미커밋/삭제/추가 파일 승인·symlink/비밀 제외·0600/atomic local draft·요약 10분 조건·사용량 임계값·metadata 신원 canary 검사.
- 실제 Codex CLI 0.153.4: 새 TypeScript adapter로 metadata 읽기 성공, 플랜 필드 있음, 요청한 codex bucket 창 2개 중 사용률 관측 1개. 실제 값/이메일/계정 식별은 보고/커밋에서 제외. 완전한 한도 정보라고 표시하지 않음.
- Chromium 데스크톱 1440px/모바일 390px: 로컬 로그인 → 프로젝트 연결 → 인계서 업로드 → 게시 → 새로고침 후 잔액/예치 → 취소/환불 → 개인정보 설정 저장/새로고침. 실제 HTTP/DB, GitHub는 명시적 테스트 응답.
- 브라우저에서 발견한 알림/선택 입력 반영과 다중 화면 조회 rate-limit 문제를 수정하고 재검증했다. 데스크톱/모바일 스크린샷을 직접 확인했다.

최종 검사 건수/CI 결과는 PR 본문과 TH-027 작업 인수인계에 기록한다. 미검증 외부 환경을 테스트 통과로 포함하지 않는다.

## 공개 베타 전 차단 조건

1. 사용자 본인의 GitHub OAuth App 등록 후 실제 로그인. 현재 로컬 샘플 로그인만 바로 사용 가능.
2. 로컬 신고를 믿지 않는 실제 구독 자격/중복 검증과 최신 가격표. 엔진 테스트용 합성 가격이 실제 플랜 가격이 아님.
3. 격리/자원 제한/credential 경계 검증 후에만 타인 코드를 실행. 현재 호스트 namespace 권한 오류가 있어 실제 runner 활성화 안 함.
4. Claude·macOS/WSL2/native Windows 검증 및 패키지 설치/자동 hook. 모바일 브라우저 통과는 OS용 CLI 설치 검증이 아님.
5. TH-012 이후 추천/수락/수행/제출/48시간 정산/데이터 보존·삭제/배포·복구/제공사 허용 검토/최종 출시 결정.

현재 버전은 검토 가능한 개발 결과이며 4일차 계획의 모든 외부 검증까지 완료하거나 공개 출시한 상태가 아니다.
