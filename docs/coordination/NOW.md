# 현재 할 일 — 두 사람이 보는 첫 보드

2026-09-23 최신 진행: 사용자 요청으로 [TH-038](tasks/TH-038.md)(요청자 흐름 — 폴더 확인, 자연어 조건 입력·AI 초안 제거, 요청별 새 저장소에 전체 파일)을 `feat/TH-038-requester-flow`에서 진행한다. 진척은 docs/handoffs/TH-038을 따른다.

2026-09-20 최신 진행: 륜호 TH-030 원격 `886a930`을 Teamspace/TIG에 clone했고 사용자 요청으로 TH-037 도움말을 그 위에서 구현한다. 유찬은 `feat/TH-037-cli-help`의 한국어 시작 순서·전체 기능 안내를 검증한다. 륜호의 TH-030은 아직 main에 미병합이며 기존 인계의 비밀 게이트/자동 검증 미해결 사항은 유지한다. 아래는 9월 10일 main 기준 이력이다. 최신 기능 설명은 USER_GUIDE와 `tig help`를 따른다.

최종 제품·병합·출시 결정자는 유찬이다. 2026-09-10 사용자 요청으로 PR #8 → #9 → #10을 main에 병합했다. **최신 구현 기준은 main, CLI 0.5.0**이다. [병합 증거](../verification/TH-036-main-integration.md)와 GitHub 실제 상태를 따른다. 과거 handoff의 미병합 안내는 당시 기록이다.

## 현재 배정과 다음 행동

| 사람 | 작업/상태 | 다음 행동 |
|---|---|---|
| 유찬/timeistoken | TH-036 main 통합 / REVIEW | 통합 검사 확인 후 본인 요청으로 tig work의 실제 생성 결과 확인. 이후 수행자 격리·필수 검사·일반 거래 연결 |
| 륜호/rhkim00 | TH-030 웹 제품화 / TODO, 착수 보고 없음 | 본인 브랜치에 최신 main을 반영하고 웹 온보딩·설치·결과 확인·실패 복구 안내 구현 |

사람 간 상호 리뷰는 기록되지 않았다. TH-033~035의 REVIEW는 유지하되 실제 main 병합 사실과 구분한다. 륜호의 기존 웹 담당 범위와 유찬의 서버/CLI 범위를 유지한다. Git 기록이 없는 별도 진행은 추정하지 않는다.

## 지금 사용할 수 있는 것

- `tig`: 최초 연결을 기억하고 자연어 작업·보상 → Codex 명세 작성 → 공개 파일 확인 → Git 및 웹 게시. 마지막 질문은 `yes / details / later`이며 한글 답변도 받는다. [요청자 사용법](../REQUESTER_QUICKSTART.md).
- 실제 TIG_test 요청의 공개 Git 명세·코드와 플랫폼 OPEN 상태, 400 TIG 예치를 확인했다. [게시 UX 및 확인 근거](../ux/requester-posting-review.md).
- `tig work`: 본인 게시 요청으로 공식 Codex 코드 작성·수행내역서·별도 로컬 Git 결과를 만드는 개인 체험. 프로젝트 테스트 실행·마켓 제출·TIG 지급은 연결되지 않았다. 실제 사용자 요청의 AI 생성 완료는 아직 미검증이다. [수행자 사용법](../WORKER_QUICKSTART.md), [검증 범위](../verification/TH-035-worker-trial.md).
- 기존 웹/API/DB, 거래·원장·48시간 검토/지급·환불의 fixture 통합 검사, Inbox·Insights·결과 다운로드. 실제 수행자 전체 거래 성공과 fixture 성공은 구분한다.

앱은 TIG 루트에서 `bash scripts/dev-local.sh`, 웹은 `http://localhost:4173`이다. 원격 PC는 SSH 포트 전달을 사용한다. **같은 서버에 연결해야 같은 거래를 본다. Git push/pull은 DB를 복제하거나 설치된 CLI를 업데이트하지 않는다.** [개발 환경](../DEVELOPMENT.md), [웹·CLI 테스트](../TRY_TOGETHER.md).

## 륜호가 최신 코드를 받을 때

먼저 본인 clone에서 `git status --short --branch`로 변경을 확인한다. 새 clone은 main이 최신이다. 기존 TH-030 브랜치는 이전 구현 기준이므로 main을 받아야 한다. 로컬 TH-030 브랜치가 있으면 `git switch feat/TH-030-web-product`, 없으면 `git fetch origin` 후 `git switch --track origin/feat/TH-030-web-product`로 이동한다. 미커밋 변경이 있으면 본인 AI가 보존 방법부터 확인한다.

본인의 TH-030 브랜치에서:

```bash
python3 scripts/team.py sync --person rhkim00
git fetch origin
git merge --ff-only origin/main
```

분기로 fast-forward가 실패하면 AI가 두 변경을 비교해 통합한다. reset/clean/force push로 덮어쓰지 않는다. Node 24 환경에서 `npm ci` 후 `npm run cli:install`로 설치 CLI도 갱신한다. 후속 PR base는 main이다. 개발 종료 때 새 handoff와 코드를 함께 commit/push한다.

웹 온보딩은 최신 요청자/수행자 사용법과 맞추고 개인 체험 결과를 지급 완료로 표시하지 않는다. API/schema 등 공통 계약 변경은 유찬과 조율한다. 기록과 진행 조회는 [협업 절차](../COLLABORATION.md)를 따른다.

## 남은 구현부터 배포까지

| 순서 | 유찬/서버·CLI | 륜호/웹·UX | 합류 조건 |
|---|---|---|---|
| 다음 | 공식 AI runner·격리/자원/권한·실제 모델 조건 검증 | 기기/AI 연결·설치·지원 OS·실패 복구 온보딩 | 실제 지원 환경에서 승인한 한 작업만 실행/중단/제출 |
| 병행 | 외부 GitHub OAuth 등록·신뢰한 구독 자격/플랜·주간 지급 연동 | 가입/확인 대기/연결 오류/주간 TIG 안내 | 자기 신고로 TIG를 발행하지 않고 실제 계정 확인 |
| 실행 연결 후 | 모델 조건 추천·Git 결과 PR·Apply changes, 이메일 수신/전달 | 추천 한 건→수락, 결과 비교/적용·알림 설정 | 실제 GitHub 작업 결과 제출·정산·별도 적용 |
| 운영 보완 | 원천/패키지 보존·사용자 내보내기/삭제·복원 후 삭제 재적용, 관리자/공개 집계 | 개인정보 설정·내 데이터·문의·집계 빈 상태 | 권한/보존/삭제·분모·원장 일치 |
| 출시 후보 | 스테이징·TLS·비밀 관리·백업/복원·롤백 | 외부 신규 계정·모바일·설치/업데이트 QA | 외부 거래/지급/환불·보안·복구 검증 |
| 마지막 | 유찬 공개 출시 결정/배포 | 초기 운영 확인 | 승인 및 실제 배포 증거 |

현재 호스트의 프로젝트 명령 실행 격리는 사용할 수 없다. 요청자 초안 및 개인 수행자 코드 생성은 가능하지만, 일반 수행자의 프로젝트 실행·필수 검사·자동 제출은 별도 구현/검증이 필요하다. 외부 OAuth, 구독 자격, OS 검증과 공개 베타 배포도 남아 있다.

## 폴더와 이력

관리 루트는 `/mnt/imclab_data2/yccho/TIG`, 보조 worktree는 `.worktrees/`, 개발 DB/runtime은 `.local/`이다. 기존 브랜치·worktree·사용자 테스트 폴더/게시 요청을 보존했다. 저장소는 timeistoken/TaskHub, 제품명은 Tokenisgold다. 이번 main 통합은 공개 서비스 배포를 뜻하지 않는다.
