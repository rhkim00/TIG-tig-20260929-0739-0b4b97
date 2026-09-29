# TH-029 — CLI 설치와 두 계정 거래 검증

2026-09-09, 유찬 구현. [PR #5](https://github.com/timeistoken/TaskHub/pull/5), base 협업 PR #4. main 미병합, 공개 배포 아님.

## 구현한 범위

- 기존 Day 1~2의 모노레포/CI/웹/API/DB/원장/기기 연결과 Day 3~4의 인계·게시 기반을 포함한다. 일부 외부 연동은 기존부터 미완료이며 날짜만으로 완료를 주장하지 않는다.
- DB migration 003: 단일 활성 수행자, claim generation/상태 기한/교체 횟수/제출/검토 기한. 원자적 수락, 시작/중단/재개/heartbeat, 기간 만료 권한 회수, 한 번 교체, 기한 초과 환불.
- 서버가 고정 JSON fixture의 필수 결과를 검증하고 artifacts/수행내역을 참여자에게 제공한다. 48시간 검토, 승인 지급/문제 신고 전액 환불, 무응답 자동 지급, 정산 경쟁/중복 방지.
- 별도 브라우저 두 계정의 실제 HTTP/DB 거래 화면. 샘플 TIG와 AI 미실행을 항상 표시한다. 웹과 CLI가 같은 기기 인증/API/원장을 사용한다.
- Node 24 CLI tarball 생성/로컬 설치, 명령 `task`, `demo-post`, `accept`, `start`, `heartbeat`, `interrupt`, `resume`, `submit`, `demo-run`, `approve`, `issue`.
- root TIG에 runtime/개발 DB/의존성, `.worktrees/`에 기존 작업 이력 보존. 륜호 웹 시작 브랜치를 최신 기준에서 준비한다. 재시작 스크립트는 기존 로컬 DB만 재사용한다.

## 실제 검사

| 검사 | 결과 |
|---|---|
| npm run build / TypeScript | 통과 |
| npm run cli:install; /home/imclab4/.local/bin/tig --help | tarball 및 로컬 명령 설치/실행 |
| TIG_TEST_CLI=<설치된 main.js> npm test | 28개 통과. 실제 PostgreSQL 고유 schema. 설치된 CLI를 HTTP 서버에 연결해 수행자 제출 → 웹 세션 승인/잔액 확인 |
| npm run test:e2e | 4개 통과. desktop/mobile, 두 브라우저 계정. 게시/수락/실패 결과/정상 결과/지급 및 환불, 반응형·기존 게시/취소·개인정보 설정 |
| 실행 중 앱 smoke | http://localhost:4173/health 정상, 실제 개발 웹에서 요청자 로그인·테스트 게시 버튼·수행자 전환 확인 |
| 협업/계약 검사 | workspace/DAG/8상태 19전이 정적 검사, team 도구 7개, git diff --check 통과 |
| 원장/동시성 | 두 수행자 경합, 수행자 중복 수락, 오래된 generation, 1회 교체, 정확한 48시간, approve/issue 경합, 중복 Worker, outbox 실패 시 정산 rollback, 비참여자 결과 차단 |

테스트 GitHub 응답은 명시적 mock이고 fixture 실행은 안전한 JSON 검사다. 실제 AI 호출/구독/모델 증명 검사가 아니다. 테스트는 자기 임시 schema만 삭제한다. 설치본 검증에서 기기 토큰을 로그나 Git에 남기지 않았다.
브라우저 스크린샷은 `.local/screenshots/review-{desktop,mobile}.png`에 보관하며 Git에 넣지 않는다.

최초 회귀 검사에서 일반 OPEN 작업 scope 노출을 발견하여 참여자만 보도록 복구했고 재검사 통과했다. 모바일 테스트에서는 접힌 메뉴의 계정 표시 대신 항상 보이는 개발 배너에 계정을 표시하도록 보완했다.

## 남은 공개 베타 조건

실제 OAuth 앱 등록/외부 계정 로그인, 제공사 조건 및 신뢰 가능한 구독 자격 검증, 실제 모델·노력 수준 매칭/추천, Codex·Claude 공식 실행/격리·자원·네트워크·권한 검증, Git 결과 PR/Apply changes, native Windows 설치/실행 검증, 이메일 알림, 분석 보존/삭제/내보내기/집계, 스테이징·TLS·백업/복원/롤백·외부 사용자 QA. fixture 성공을 이 조건들의 완료로 취급하지 않는다.

외부 사용자가 자유 가입해 실제 AI 코딩을 거래하는 공개 베타는 아직 아니다. 현재 유찬/륜호가 개발 서버에서 역할을 나눠 제품의 거래 동작을 직접 확인할 수 있다.
