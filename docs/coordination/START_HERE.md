# 각자의 AI에서 시작하기

최신 사용자 지시: 유찬 세션이 TH-027에서 Day 1~4 통합 선행 구현을 진행했다. 아래 최초 시작 지시문보다 [TH-027 결과](../verification/TH-027-day4.md)와 PR #3를 먼저 읽는다. 륜호는 이미 구현된 초기 화면을 중복 작성하지 않고 UX/코드 리뷰 후 잔여 작업을 조율한다.

현재 배정과 선행 조건은 [전체 워크플로우](WORKFLOW.md)와 [보드](BOARD.md)를 따른다.
Codex/Claude Code 어느 도구로 바꾸어도 공통 문서와 같은 작업 브랜치를 사용한다.
`CLAUDE.md`도 `AGENTS.md`를 참조한다. 실제 앱 기능은 선행 작업을 통과한 순서대로 구현한다.

## 유찬: TH-001 계속

폴더: `/mnt/imclab_data2/yccho/TIG/.worktrees/TH-001-feasibility`

```text
나는 timeistoken(유찬)이야. AGENTS.md, docs/coordination/PROTOCOL.md,
WORKFLOW.md, BOARD.md, tasks/TH-001.md와 docs/product/00_confirmed.md를 읽어줘.
워크플로우/보드/작업 문서는 docs/coordination/ 아래에 있어.
fetch 후 main과 열린 PR의 최신 기록을 확인하고 기존 TH-001을 이어서 진행해줘.
docs/verification/TH-001-feasibility.md의 실제 검증과 미검증을 구분해줘.
실행 격리/공식 AI 연동의 장애물과 스택 결정을 구체화하고, 륜호의 TH-002 화면 요구를 받아 TH-003 계약으로 연결해줘.
륜호 작업 폴더를 수정하지 말고, 정책 변경은 내가 결정하게 해줘.
끝나면 실제 검증·장애물·다음 행동을 작업 문서에 남기고 commit/push해줘.
```

## 륜호: TH-002 시작

서버에 준비한 폴더: `/mnt/imclab_data2/yccho/TIG/.worktrees/TH-002-english-ux`
본인 컴퓨터에서는 [워크플로우의 clone 절차](WORKFLOW.md)를 따른다. 본인 계정/clone 사용을 권장한다.

```text
나는 rhkim00(김륜호)이야. AGENTS.md, docs/coordination/PROTOCOL.md,
WORKFLOW.md, BOARD.md, tasks/TH-002.md와 docs/product/00_confirmed.md를 읽어줘.
워크플로우/보드/작업 문서는 docs/coordination/ 아래에 있어.
fetch 후 main과 열린 PR의 최신 기록을 확인하고 배정된 TH-002를 시작해줘.
docs/ux/에서 가입/연결, 홈, 게시, 추천/마켓, 실행, 결과, 설정의 영어 화면을 설계해줘.
자연어 게시 → 추천 한 건 → Yes → 결과 검토가 중심이야.
오류/빈 상태/오프라인/환불/48시간 자동 지급과 별도 Apply changes도 포함해줘.
화면별 필요한 API 데이터를 정리하고 유찬의 TH-003 계약으로 인계해줘.
서버/공통 계약/루트 설정을 임의로 바꾸지 말고 필요한 변경은 기록해줘.
내 실제 착수를 작업 문서 IN_PROGRESS로 기록하고 Draft PR을 만들어줘.
끝나면 실제 검증·장애물·다음 행동을 작업 문서에 남기고 commit/push해줘.
```

## 모든 세션 종료 기록

작업 문서에 상태, 변경 파일, 기준 커밋/참조 계약, 실제 검사 명령과 결과,
미검증 사항, 장애물, 다음 행동, 커밋/PR을 기록한다. 비밀정보/개인 AI 대화 전문은 저장하지 않는다.
push하지 않은 변경은 상대방에게 전달되지 않았다고 명시한다.
REVIEW는 병합 완료가 아니다. 상대 리뷰와 유찬의 병합 결정 후 main 병합 증거를 확인해야 DONE이다.

## 조율 요청

```text
main과 열린 PR의 최신 작업 기록을 읽고 두 사람의 진행을 조율해줘.
python3 scripts/check_workflow.py 결과와 원격 병합 증거를 대조해줘.
각자 다음에 할 일 1개, 선행 작업, 수정 경로 충돌, 필요한 리뷰를 알려줘.
새로운 배정/계약 변경은 유찬에게 제안하고 다른 담당자의 작업을 임의로 수정하지 마.
```

점검기는 로컬 DAG를 확인한다. 자동 작업 배정/예약 실행/실시간 동기화 기능은 없다.
