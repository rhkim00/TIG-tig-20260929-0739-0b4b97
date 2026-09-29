# 두 사람이 Git으로 일하는 방법

목표는 “커밋하고 push해 놨어”라는 말만으로 상대 AI가 변경과 다음 일을 이해하는 것이다.
기록은 `docs/handoffs/<작업ID>/<시각>-<작성자>.json`, 배정은 `docs/coordination/assignments.json`, 현재 순서는 [NOW](coordination/NOW.md)다.
AI 대화 전문/내부 추론/credential은 기록하지 않는다. 실제 코드 변화·판단 이유·검사·장애물·다음 행동만 남긴다.

## 최초 한 번

각자 본인 계정으로 별도 clone을 사용한다. 한 서버의 linked worktree는 Git 인증/설정이 공유되므로 계정 분리 수단이 아니다.
이 서버의 관리 루트는 `/mnt/imclab_data2/yccho/TIG` 하나이며 보조 worktree는 `.worktrees/` 안에 있다. DB·개발 runtime도 루트 `.local/`에 모았다.

륜호의 새 컴퓨터(main에 최신 앱과 협업 문서가 포함돼 있다):

```bash
git clone https://github.com/timeistoken/TaskHub.git TIG
cd TIG
git config user.name "본인 커밋 이름"
git config user.email "본인 GitHub 이메일 또는 noreply 주소"
python3 scripts/team.py setup --person rhkim00
python3 scripts/team.py sync --person rhkim00
```

유찬의 현재 clone에는 timeistoken으로 setup을 적용한다. GitHub 로그인은 각자 `gh auth login`. 다른 사람 이름/인증을 공유하지 않는다.
개발 전에 본인 TH-030 브랜치로 전환하고 main을 반영한다. 새 clone이면 `git switch --track origin/feat/TH-030-web-product`, 이미 로컬 브랜치가 있으면 `git switch feat/TH-030-web-product`를 사용한다. 이어 [NOW](coordination/NOW.md)의 통합 안내를 따른다. main에서 직접 개발하지 않는다.
Node/DB 실행은 [DEVELOPMENT](DEVELOPMENT.md)를 따른다. 협업 읽기/기록은 Python과 Git만으로 가능하다.

## 매번 시작

```bash
python3 scripts/team.py sync --person rhkim00
```

유찬은 timeistoken. sync는 fetch, 열린 PR 조회, 마지막 조회 이후 diff 요약, 최근 인수인계와 양쪽 다음 행동을 보여준다.
**fetch는 내 코드 파일을 바꾸지 않는다.** 같은 작업 브랜치의 원격 변경을 반영할 때 미커밋 파일을 확인하고 아래 명령을 실행한다.

```bash
git status --short --branch
git pull --ff-only
```

실패하면 멈추고 AI에게 충돌/분기 상태를 설명하게 한다. reset/clean/force push로 덮어쓰지 않는다.
새 작업은 승인된 기준에서 작업별 브랜치를 만든다. 다른 사람의 브랜치/checkout을 임의 변경하지 않는다.
PR #1~#10은 main에 병합됐다. 후속 PR base는 main이다. 과거 stacked 브랜치는 이력 보존용이며 현재 개발 기준은 최신 main이다. 미검증 외부 기능은 병합만으로 완료되지 않는다.

## 작업 중·종료·중단: 반드시 공유

1. 자신의 담당 범위에서 작업하고 관련 검사를 수행한다. 웹은 륜호, API/공통 schema/migration/lockfile/CI는 유찬 소유다. 상대 범위가 필요하면 변경 요청을 기록하고 조율한다.
2. 의미 있는 변경이 생겼거나 상대가 이어받아야 하거나 세션을 끝낼 때, 변경 파일을 골라 staging한다. `git add .`를 무심코 사용하지 않는다.
3. AI가 아래 형식으로 `/tmp/handoff.json` 같은 임시 입력 파일을 작성한다. 미실행 검사를 통과라고 쓰지 않는다.
4. record → commit → push → PR 생성/갱신까지 한다. 실패하면 어디까지 공유됐는지 보고한다.

```bash
git add apps/web/src/변경파일.tsx docs/ux/변경문서.md
python3 scripts/team.py record --file /tmp/handoff.json
git commit -m "feat(TH-030): describe the visible change"
git push -u origin HEAD
```

예시 입력(복사한 예시 문구 그대로 커밋하지 말고 실제 내용을 적는다):

```json
{
 "task":"TH-030",
 "status":"IN_PROGRESS",
 "summary":["무엇이 어떻게 바뀌었는지와 그 이유"],
 "checks":[{"command":"실행한 명령","result":"passed","details":"실제 결과; 미검증 범위"}],
 "blockers":[],
 "next":{
  "timeistoken":{"task":"TH-029","action":"서버 담당자가 다음으로 해야 할 구체적 행동","dependsOn":"선행 결과 또는 없음"},
  "rhkim00":{"task":"TH-030","action":"웹 담당자가 다음으로 해야 할 구체적 행동","dependsOn":"선행 결과 또는 없음"}
 }
}
```

record가 작성자/브랜치/기준 SHA/시각/실제 staged 파일 목록을 자동으로 채운다. commit 전에 hook이 인수인계 누락·범위 이탈·양쪽 다음 행동 누락을 막는다.
이전 인수인계는 수정하지 않고 정정 기록을 새로 추가한다. 파일별 인수인계가 있으므로 공용 로그 한 파일을 두 사람이 덮어쓰지 않는다.
작업 미완료라도 안전한 중간 결과는 IN_PROGRESS 또는 BLOCKED로 기록해 commit/push한다. 파일 저장할 때마다 커밋할 필요는 없지만 세션 종료/인계 전에 공유는 필수다.

## 상대가 “커밋하고 push했어”라고 하면

내 AI에게 “team sync로 최신 인수인계를 읽고 내 할 일을 알려줘”라고 하면 된다. 별도 구두 설명은 정상적인 인계의 필수 조건이 아니다.
다만 상대가 push하지 않은 로컬 코드, 기록하지 않은 결정은 볼 수 없다. AI는 그 공백을 사실처럼 채우지 않는다.
인수인계의 next는 등록된 배정 안의 다음 행동이다. 새 업무/범위/정책을 임의 배정하는 권한은 없고 유찬의 결정이 우선한다.

## PR·리뷰·병합

- PR은 변경을 검토하고 합치는 단위다. 일찍 Draft PR을 열어 진행 중임을 공유한다.
- 검사가 통과하고 리뷰 가능하면 REVIEW, 상대가 코드/UX/정책을 리뷰한다.
- **main 병합과 공개 출시는 유찬이 결정한다.** 커밋/push/PR 작성은 병합/배포가 아니다.
- PR의 base가 다른 작업 브랜치면 선행 PR부터 병합한다. 선행 squash 병합 이후 base 변경/중복 diff는 AI가 확인하고 정리한다. 다른 사람 브랜치에는 force push하지 않는다.
- 실제 병합 URL/커밋 증거가 있어야 DONE. 다음 인수인계에서 완료를 기록한다.

## 실제로 강제되는 것과 한계

로컬 hook은 setup한 clone에서 적용된다. clone만으로 Git hook은 자동 설치되지 않으므로 setup은 필수다.
CI는 도입 이후 PR 커밋별 새 인수인계/범위/필수 필드를 검사한다. hook을 우회해도 CI에서 확인한다. 검사 결과 문장의 진실성은 실제 CI와 리뷰로 대조해야 한다.
브랜치 보호는 아직 서버에서 강제된 것으로 보장하지 않는다. AI가 다른 세션을 자동 실행하거나 Git 파일을 분산 잠금으로 사용하지 않는다.
