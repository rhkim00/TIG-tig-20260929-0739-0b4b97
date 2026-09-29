# Tokenisgold

터미널에서 **`tig help`**를 입력하면 처음 실행할 명령부터 요청자·수행자 흐름, 전체 기능을 한국어로 볼 수 있습니다. 특정 명령은 `tig help work`, `tig help request publish` 또는 `tig <명령> --help`로 확인하세요. 도움말은 로그인이나 서버 연결 없이 동작합니다.

**clone 직후 [START_HERE](START_HERE.md)를 읽고 [현재 할 일](docs/coordination/NOW.md)을 확인한다.** 모든 개발 폴더는 TIG 아래로 통합됐다.

자신의 AI 사용 여유로 다른 사람의 코딩 작업을 수행해 TIG를 얻고, 사용량이 부족할 때 TIG로 작업을 맡기는 P2P 작업 교환 플랫폼.

목표: 10일 내 구현 완료와 외부 사용자용 공개 베타 출시. Day 1~4 기반 이후 TH-029 거래, TH-031 알림·개인 인사이트·결과 다운로드까지 구현했다. 외부 로그인/구독 자격/실행 격리는 추가 검증이 필요하다.
최종 결정자는 유찬(`timeistoken`)이다. TypeScript/PostgreSQL과 역할은 승인됐고, 실행 가능한 웹/API/PostgreSQL/CLI와 초기 계약이 main에 병합됐다. 사람 간 상호 리뷰는 아직 기록되지 않았다.

서비스명은 **Tokenisgold**, 작업 포인트 표기는 **TIG**다. TIG는 현재 현금 구매·출금·직접 송금 없는 서비스 내부 포인트다.
GitHub 저장소 주소는 기존 `timeistoken/TaskHub`를 유지한다. 서비스 브랜딩 변경과 저장소 URL 변경은 구분한다.

## 요청자 AI에서 Git 요청 게시

`tig` 하나로 폴더를 확인하고 작업·수행자 도구·모델·추론 수준·TIG를 자연어로 받은 뒤(AI 초안 없음), 요약 확인 → 요청마다 새 공개 저장소에 작업 트리 전체 게시 → 웹 등록을 안내한다. [VS Code 요청자 사용법](docs/REQUESTER_QUICKSTART.md)을 따른다. 본인 게시 요청으로 `tig work`를 실행하면 AI 코드 작성·로컬 Git 결과를 체험한다. [수행자 사용법](docs/WORKER_QUICKSTART.md). 실제 테스트 실행·마켓 제출·TIG 정산 연결은 후속이다.

## 앱 실행

[두 사람이 웹·CLI로 테스트하기](docs/TRY_TOGETHER.md), [개발 환경](docs/DEVELOPMENT.md), [최신 구현·검증](docs/verification/TH-035-worker-trial.md), [main 통합 기록](docs/verification/TH-036-main-integration.md).

현재 서버에서는 `TIG`에서 `bash scripts/dev-local.sh`로 실행한다. 새 컴퓨터는 실행 안내의 Node 24/DB 설정을 따른다.

## 먼저 읽을 문서

- [제품 결정 문서](docs/product/README.md): 카테고리별 동작·정책·기술·출시 결정 목록
- [최신 확정사항](docs/product/00_confirmed.md): 대화에서 확정한 내용과 근거
- [서비스 기획서](Tokenisgold_service_plan.txt): 명칭을 반영한 기준과 장기 방향
- [핵심 자연어 UX](docs/product/13_agent_workflow.md): 작업 인계·가용성 등록·매칭·수행·평가
- [초기 기획서 보관본](docs/archive/TaskHub_service_plan_2026-09-09.txt): 이전 명칭의 원문
- [협업 가이드](docs/COLLABORATION.md): 브랜치, 리뷰, AI 세션 운영
- [구현부터 배포까지](docs/coordination/WORKFLOW.md): 의존성 그래프, 두 사람의 배정, 10일 목표와 합류 기준
- [작업 현황](docs/coordination/BOARD.md): 작업 순서와 담당 영역
- [각자의 AI 시작 방법](docs/coordination/START_HERE.md): 복사해서 사용하는 공통 지시문
- [상태 공유 절차](docs/coordination/PROTOCOL.md): 로깅, 진행 조회, 충돌 조율
- [협업 결정 기록](docs/DECISIONS.md): 내부 개발 환경 기록과 제품 문서 연결
- [AI 작업 규칙](AGENTS.md): 모든 프로젝트 AI 세션의 공통 기준

## 시작

원격 저장소 연결 후 각자 별도 폴더에 clone한다. 같은 작업 디렉터리를 두 사람이 함께 수정하지 않는다.

```bash
git clone https://github.com/timeistoken/TaskHub.git Tokenisgold
cd Tokenisgold
git config user.name "본인 이름"
git config user.email "본인 GitHub 이메일 또는 noreply 이메일"
python3 scripts/team.py setup --person rhkim00
python3 scripts/team.py sync --person rhkim00
git switch --track origin/feat/TH-030-web-product
git merge --ff-only origin/main
```

새 clone은 main을 받는다. 위 setup과 작업 브랜치 전환은 륜호의 배정 TH-030 예시다. 유찬은 timeistoken과 자신의 배정 브랜치를 사용한다. 작업 전 작업 문서에서 담당자와 범위를 확인한다.
문서·협업 구조 검사 외에 `npm run build`, `npm test`, `npm run test:e2e`로 실제 앱·DB·브라우저를 검사한다. 실행 안내의 테스트 DB 설정이 필요하다.

```bash
python3 scripts/check_workspace.py
git diff --check
```

원격 저장소: https://github.com/timeistoken/TaskHub (비공개). 저장소 소유자는 `timeistoken`이며 현재 로컬 커밋 작성자는 `yuchan`이다. 팀원은 `rhkim00`이며 저장소 접근을 확인했다. 담당은 P-055로 확정됐으며 실제 진행은 작업 문서와 열린 PR에서 확인한다. 개발자 신원 설정은 각자 수행한다.

## 기술 검증 진행

[TH-001 결과](docs/verification/TH-001-feasibility.md)와 [구현 계약 초안](docs/contracts/README.md)은 [PR #2](https://github.com/timeistoken/TaskHub/pull/2)로 main에 병합됐다. TH-001의 실제 AI 실행·격리·구독 검증은 BLOCKED로 유지한다. [병합 기록](docs/verification/TH-032-main-integration.md)에서 전체 PR과 근거를 확인한다.
