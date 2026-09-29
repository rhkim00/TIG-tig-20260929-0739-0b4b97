# 수행자 첫 체험 — tig work

CLI 0.5.0에 본인이 게시한 요청으로 수행자 흐름을 체험하는 기능을 추가했다. 수행자 환경에 설치된 공식 CLI(Codex 또는 Claude Code)가 코드 변경과 수행내역서를 작성한다. 둘 다 설치돼 있으면 요청이 지정한 provider를 보여주되 기본값 없이 수행자가 직접 고르고, 하나만 있는데 요청과 다르면 대체 여부를 한 번 묻는다. 결과에는 실제 사용한 provider를 기록한다. 결과는 별도 로컬 Git에 저장한다. **프로젝트 코드 실행/테스트·마켓 제출·GitHub PR·TIG 지급은 아직 수행하지 않는다.** 원래 요청의 예치와 24시간 완료 기한도 그대로 유지된다. 개인 체험이 거래를 완료하거나 기한을 연장하지 않는다.

## 실행

요청자 때 연결한 같은 TIG 계정으로 터미널에서 실행한다. 원본 프로젝트 폴더로 이동할 필요는 없다.

```bash
tig work
```

최근 본인 Git 요청 하나를 가져온다. 자동 마켓 추천이나 quota 라우팅이 아니다. 특정 요청을 쓰려면 `tig work <task-id>`.

```text
◆ Complete and validate the shortest-path solution in solution.py  personal trial

Requested: astra / medium
CLI will request: gpt-6-astra / medium
1 code files · 400.00 TIG stays reserved on the posted task.
[ChatGPT 사용량으로 작성, 별도 로컬 결과 저장, 코드 실행·거래 제출 없음 안내]

› Start this personal worker trial? (yes/no) [no]
❯ 네

◐ Codex is implementing the request…
◐ Saving code, report and local Git history…

◆ Code and work report saved  personal trial
Result: [로컬 결과 폴더]
Report: [로컬 결과 폴더]/report.md
Local Git commit: [커밋]
Runtime tests: not run. Submission: not sent.
```

현재 설치 환경의 공식 모델 목록에서 astra에 gpt-6-astra가 한 후보로 확인되고 medium이 지원됨을 읽기 전용 검증했다. 모델 가용성은 바뀔 수 있어 새 실행 때 다시 조회한다. 별칭을 정식 실행 ID로 보여준 뒤 사용자가 시작을 승인한다. 후보가 여러 개이거나 추론 수준을 지원하지 않으면 실행하지 않는다. 이 확인은 요청 모델을 CLI에 지정할 수 있다는 근거이며 제공사 실행 증명은 아니다.

Claude Code에는 조회 가능한 모델 목록이 없다. 요청한 모델 이름을 그대로 `--model`에 넘기고(별칭 매핑 없음) 화면에 "not verified by TIG"로 표시한다. 추론 수준은 Claude Code의 `--effort` 값(low, medium, high, xhigh, max)만 허용하며, 다른 값이면 AI를 호출하지 않고 중단한다.

## 결과

화면의 결과 폴더를 VS Code로 열면 다음 파일이 있다.

- `code/`: AI가 변경한 코드와 유지된 파일. 원래 프로젝트를 덮어쓰지 않는다.
- `request.md`, `request.json`: 받아온 불변 요청.
- `report.md`: AI 수행 설명, 제안 테스트, 한계, TIG가 기록한 미실행 상태.
- `result.json`: 원본 커밋·패키지 해시, 요청 모델/추론, 로컬 경과 시간, 파일 해시·검사 출처.
- Git: 원본 패키지와 결과의 두 커밋. diff로 변경 확인 가능. GitHub에 push하지 않는다.

같은 요청으로 `tig work`를 다시 실행하면 기존 결과 경로를 보여주고 AI를 재호출하지 않는다. AI 결과 저장 후 Git 작성이 실패하면 저장된 결과로 이어서 만든다. Ctrl+C는 진행 중 AI를 중단하고 기존 파일을 남긴다. 비정상 프로세스 종료로 잠금 파일이 남으면 오류에 표시한 파일을 확인해 복구해야 한다; 살아 있는 다른 세션을 자동으로 덮어쓰지 않는다.

## 다른 사용자의 요청 수행하기 — `tig work --market`

```bash
tig doctor                 # Git·gh 로그인·Codex/Claude Code·연결 상태를 먼저 확인
tig work --market          # 사용률을 읽고 맞는 요청 하나를 제안; yes 한 번이면 제출까지 자동
tig work --watch           # 터미널에 상주: 여유가 있을 때만 제안 (기본 10분마다, --every N)
tig work <task-id>         # 특정 요청을 직접 지정 (도구 선택·수락 확인을 묻는다)
```

다른 컴퓨터·다른 GitHub 계정에서의 전체 순서(기기 연결 10분 제한, gh 계정 전환, fork 경로)는 [사용 안내](USER_GUIDE.md)를 따른다. 2026-09-13에 그 조건으로 fork→PR→제출→승인→지급 1사이클을 검증했다([기록](verification/TH-030-cross-machine-cycle.md)).

한도: `--market`/`--watch`는 각 도구의 사용률과 함께 **최근 한도 거부 기록**(`limit-<도구>.json`, reset 시각까지 유효)을 읽어 그 도구를 제안에서 뺀다. 실행 중 한도 메시지로 실패하면 reset 시각을 기록하고 다른 설치 도구로 대신할지 한 번 묻는다. 대신 실행할 때 요청 모델이 그 도구에 없으면 Codex는 공식 목록의 현재 모델(요청 추론 수준을 지원하면 그대로, 아니면 기본값), Claude Code는 `opus`를 쓰고 화면과 제출 기록에 남긴다.

흐름: 로컬 AI 선택 → 수락 확인 1회 → 서버 수락(claim)·시작(start) → **작업 공간**: heartbeat를 먼저 켜고 요청 브랜치(요청 저장소의 `main`; 예전 요청은 `tig/requests/<id>`)를 `<상태 폴더>/worker-trials/<해시>/ws`에 clone(고정된 커밋인지 확인; 브랜치가 옮겨졌으면 그 커밋을 sha로 다시 받고, 그것도 없으면 `REQUEST_BRANCH_MOVED`로 중단) → **AI가 그 checkout 안에서 직접 작업**(최대 20분, 5분마다 heartbeat): Codex는 `codex exec -C <ws> --sandbox workspace-write`(쓰기는 작업 공간과 /tmp만, 네트워크 없음, 명령 실행 가능), Claude Code는 `claude -p --restricted --safe-mode --strict-mcp-config --permission-mode acceptEdits --permission-prompts none --tools Read,Edit,Write,Glob,Grep`(파일 도구는 작업 공간 안으로 한정, 명령 실행 없음). 프롬프트는 "루트의 request.md를 구현하고 짧은 보고(summary·suggestedTests·limitations·commandsRun)로 끝내라"이며 도구 대체·모드 축소는 없다(P-052) → **diff → 검사**: `git add -A` 뒤 `request.md`/`request.json` 변경은 원복, 보호 경로(`.env*`, `.github/workflows/**`, 키·자격증명 파일, `node_modules` 등)·심볼릭 링크·중첩 저장소는 커밋에서 빼고 `report.md`에 사유와 함께 적는다. **.gitignore 규칙: 통째로 무시되는 디렉터리(`node_modules/`, `.venv/`, `build/`)는 절대 강제 추가하지 않고 이름만 `report.md`에 남기고, 개별 파일 하나가 무시된 경우(`*.generated.ts` 등, 최대 50개)만 `git add -f`로 담되 보호 경로·심볼릭 링크·크기·비밀 검사를 똑같이 적용한다**(걸리면 빠지고 사유가 남는다). 도구가 쓴 무시 경로는 커밋에 들어갔든 빠졌든 화면과 `report.md`에 이름으로 공시한다. **비밀 검사는 한 게이트가 보증한다**(`apps/cli/src/secret-gate.ts`, 요청자 쪽과 같은 것): 변경 파일 목록이 아니라 **push될 결과 커밋 자체**를 읽어 그 커밋이 가진 blob을 전부(수행자가 건드리지 않은 요청자 파일까지) `git cat-file`로 흘려 읽으며 매칭한다. 패턴은 전부 ASCII이므로 **UTF-8 디코딩이 필요 없다** — 예전에는 UTF-8로 디코딩되는 blob만 검사하면서 나머지에도 `scanned: true`를 기록해 CP949 한글 소스나 UTF-16 파일이 읽히지도, 공시되지도 않은 채 공개 브랜치로 갔다. 크기 상한도 없다(10 MB는 커밋 전 1차 검사가 읽는 한도일 뿐이다). 건너뛰는 것은 루트의 `request.md`/`request.json`(요청 커밋과 바이트가 같을 때만)과 첫 바이트가 알려진 바이너리 컨테이너(PNG/JPEG/ZIP/gzip/PDF/ELF…)인 blob뿐이고, 후자는 `report.md`의 `## Not examined by the secret gate (N file(s))` 절과 화면 한 줄에 **게이트가 실제로 건너뛴 개수·이름·크기 그대로** 공시한다(`.gitattributes`로 binary 표시를 위조해도 판정은 실제 바이트로 한다). 게이트는 두 번 돈다: 결과를 읽어 보고서를 만들 때(작업 공간을 고칠 수 있는 시점)와 `publishWorkerResult`가 push하기 직전(모든 발행 경로가 반드시 지나가는 곳). 커밋 전 1차 검사(변경 파일, 10 MB까지)에 걸리거나 게이트에 걸리면 `RESULT_SECRET_DETECTED`로 push·제출 모두 중단하고 작업 공간은 남긴다(메시지는 경로와 패턴 분류 이름만 말하고 비밀 자체는 싣지 않는다). 10 MB를 넘는 텍스트는 커밋 전 1차 검사가 읽지 못하므로 지금도 커밋에서 빼고 사유를 남긴다. **커밋할 변경이 0건이면 제출하지 않는다**: 도구가 정말 아무것도 쓰지 않았을 때만 `<도구> made no change; nothing submitted. Run tig work <id> to try again.`이고, 쓴 파일이 무시·보호 경로라 전부 빠졌으면 `<도구> wrote files, but none of them could be committed, so nothing was submitted: <경로 (사유)>`로, 요청 문서만 건드렸으면 원복 사실을 알린다(수락은 유지되고 30분 뒤 다시 OPEN) → **Git 게시**: 요청 커밋 위의 결과 커밋을 `tig/results/<task-id>` 브랜치로 push(요청자 repo에 push 권한이 있으면 직접, 없으면 본인 fork)하고 요청 브랜치를 base로 **Pull Request**를 연다(본문 = `report.md`) → **플랫폼 제출(submit)**: 변경 파일이 모두 텍스트이고 97개·파일당 200,000자·합계 900 KB 이하이면 `code/<경로>`로 미러하고 아니면 `report.md`만(부분 미러 없음) → 요청자 검토. **PR이 변경 파일의 검토 화면이다**; 플랫폼의 파일 목록은 미러가 됐을 때만 같은 내용을 보여준다. 요청자는 PR/브랜치에서 결과 커밋을 보고 플랫폼에서 승인하면 TIG가 지급된다(PR 병합은 별개 결정; 요청 저장소는 요청자 트리의 사본이라 요청자는 cherry-pick으로 가져간다). GitHub CLI(`gh`) 로그인이 필요하다. 제출 후 상태는 `AWAITING_REVIEW`이고 요청자가 승인하면 TIG가 지급되며, 문제 접수 시 전액 환불, 48시간 무응답 시 자동 지급된다. TIG는 런타임 테스트를 실행하지 않으며 제출 기록에 `not_run`으로 표시된다(Codex가 sandbox 안에서 돌린 명령은 도구 신고로 `report.md`에만 남는다). push/제출이 실패한 뒤 같은 요청을 다시 실행하면 저장된 결과 커밋(`workspace-candidate.json`)을 재사용해 AI 호출 없이 제출만 다시 시도한다. 시간 초과·Ctrl+C 때는 도구가 띄운 하위 프로세스까지 프로세스 그룹째 종료한다. 예전 `code/` 번들 요청은 이전 방식(파일을 JSON으로 넘기고 결과 파일을 받는 방식) 그대로 처리한다.

남은 위험(유찬 결정 사항): Codex `workspace-write`는 쓰기만 작업 공간으로 막고 읽기는 막지 않으므로, 도구가 작업 공간 밖 파일을 읽어 결과에 옮겨 적을 가능성은 비밀 패턴 검사로만 걸러진다(게이트가 잡지 못하는 것: EBCDIC·UTF-7·base64 같은 변환 인코딩, 압축 컨테이너 내부, 패턴 표에 없는 형식 — 예: 고엔트로피 비밀번호)(Stage 3의 bwrap 격리는 이번 범위 밖). 본인 요청의 개인 체험(`tig work`, 자기 요청)도 tree 요청이면 같은 작업 공간 흐름으로 돌되 push·PR·제출은 하지 않는다.

## 일반 수행자 거래까지 남은 연결

현재 호스트의 bubblewrap 격리는 namespace 권한 오류로 실패한다. 검증된 격리 환경에서 코드/합의된 테스트를 실행하고 자원·네트워크 제한·중단 복구를 검증해야 한다. 이후 실제 수락/generation/heartbeat, 필수 검사 통과, GitHub PR 제출, 웹 검토와 48시간 정산을 연결한다. 타인의 작업을 consumer 구독으로 수행하고 TIG를 받는 구조의 제공사 허용/실행 증명도 별도 검증이다. 기존 마켓의 RUNNER_NOT_READY guard를 유지한다.

[Codex 구조화된 실행](https://learn.chatgpt.com/docs/non-interactive-mode), [공식 모델 목록](https://learn.chatgpt.com/docs/app-server#list-models-modellist), [구현·검증](verification/TH-035-worker-trial.md).
