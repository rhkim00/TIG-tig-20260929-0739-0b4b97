# Tokenisgold 사용 안내 — 요청자·수행자 터미널

2026-09-13에 서로 다른 두 컴퓨터(요청자: 이 개발 서버, 수행자: 다른 Linux 서버)에서 실제 GitHub 계정 두 개로 한 사이클을 검증한 순서 그대로다. 검증 기록과 운영자 준비(공개 주소·GitHub OAuth·TIG 자격)는 [TH-030 검증](verification/TH-030-cross-machine-cycle.md)에 있다. 화면 문구는 영어이며 자연어 입력은 한국어도 된다.

역할은 고정이 아니다. 같은 사람이 어떤 날은 요청자, 어떤 날은 수행자다. 단, **한 거래의 요청자와 수행자는 서로 다른 Tokenisgold 계정(=GitHub 계정)** 이어야 한다.

## 0. 어느 컴퓨터든 처음 한 번

무엇부터 할지 모르겠다면 `tig help`를 입력한다. 처음 준비 → 요청 게시 → 수행 → 결과 확인 순서와 전체 기능이 한국어로 나온다. 세부 옵션·예시는 `tig help work`, `tig help request publish` 또는 `tig <명령> --help`. 도움말만 볼 때는 로그인·서버 연결이 필요 없고 AI를 호출하지 않는다. 일반 셸에서 `help`만 치면 셸 자체 도움말이므로 **`tig help`**를 사용한다.

```bash
tig doctor
```

Node 24, Git, GitHub CLI(2.21 이상·로그인), Codex 또는 Claude Code(구독 로그인), Tokenisgold 연결을 한 표로 보여주고 ✗ 항목마다 실행할 명령을 붙인다. 모두 ✓이면 `Ready`다. 설치 자체는 아직 npm 공개 배포 전이라 [개발 안내](DEVELOPMENT.md)대로 저장소를 clone해 `npm ci && npm run cli:install`로 만든다.

| 항목                   | 준비 방법                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 24                | `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh \| bash` → `nvm install 24`                                                                        |
| GitHub CLI             | sudo 없이: 릴리스 tar.gz의 `bin/gh`를 `~/.local/bin`에 복사. 로그인: `gh auth login` (HTTPS, 브라우저)                                                                       |
| Claude Code            | `npm install -g @anthropic-ai/claude-code` → `claude` 실행 후 구독 로그인 → `claude auth status`                                                                             |
| Codex CLI              | `npm install -g @openai/codex` → `codex login`                                                                                                                               |
| Tokenisgold 연결       | 아래 1-2 / 2-1                                                                                                                                                               |
| Claude Code 연동(선택) | `tig claude-statusline install`(잔여량 표시·수행자 제안의 Claude 사용률 근거), `tig claude-notes install`(세션의 마지막 답변 저장; 요청자 흐름은 더 이상 초안에 쓰지 않는다) |

tig는 provider 토큰을 읽거나 복사하지 않는다. 로그인은 각 공식 도구가 한다. API 키 인증은 사용하지 않는다.

## 1. 요청자

**1-1. `tig` 한 번, 폴더 확인 한 번.** 어디서 실행하든 된다.

```bash
tig
```

tig가 먼저 **어느 프로젝트인지** 후보를 하나 보여 주고 묻는다: 지금 폴더가 Git 프로젝트면 그 폴더, 아니면 이 컴퓨터의 가장 최근 Claude Code/Codex 세션이 작업한 저장소, 그것도 없으면 마지막 tig 프로젝트, 그것도 없으면 지금 폴더. Enter(=yes)면 그대로 쓰고, `no`면 폴더를 **경로 또는 프로젝트 이름**으로 받는다(`~/work/app`, `../app`, 또는 "api 폴더"처럼 최근 세션·마지막 프로젝트·지금 폴더 옆/안의 폴더 이름). 이름이 여럿에 맞으면 번호로 고르고, 모르는 이름이나 없는 경로는 다시 묻는다.

```text
Project: /home/minsu/calc-practice — the folder tig was started in.
› Is this the folder to hand off? (yes/no) [yes]
❯ no
› Which folder? (a path, or the name of a project you worked on)
❯ calc 프로젝트
✓ calc-practice · 2550.00 TIG available · each request becomes a new public repository under github.com/minsu
```

**1-2. 첫 실행이면 기기 연결.** 화면의 링크를 브라우저에서 열고 **Continue with GitHub**로 로그인한 뒤 코드를 확인한다. 코드는 **10분**이면 만료되고, 터미널이 `Device connected.`를 출력할 때까지 기다린다(Ctrl-C로 끊으면 연결되지 않는다). 설치본의 기본 주소가 아닌 서버를 쓰면 먼저 `tig connect --origin https://<website> --name <이 컴퓨터 이름>`. **GitHub 계정은 매 실행 확인한다**: `GitHub: signed in as <계정>. Publish requests under github.com/<계정>?`에 Enter면 그 계정, `no`면 공식 로그인 흐름(`gh auth login`)을 열어 다른 계정으로 로그인한 뒤 다시 묻는다 — 요청 저장소는 이 계정 아래에 만들어지므로, 남의 계정으로 로그인된 터미널에서 내 프로젝트가 그 사람 계정에 올라가는 일을 막는다. 로그인이 아예 없으면 먼저 로그인을 연다. 이어서 Codex·Claude Code가 설치돼 있는지와 로그인 상태를 확인하고, 설치돼 있는데 로그인이 안 됐으면 공식 로그인을 열어 준다(설치 안 됐으면 링크만 한 줄). 결과는 `Signed in: GitHub rhkim00 · Codex · Claude Code` 한 줄로 나온다.

**1-3. 맡길 일을 한 문장으로 — tig는 아무것도 대신 정하지 않는다.** 작업 내용과 함께 수행자 도구(`codex` / `claude`), 모델, 추론 수준, TIG를 한 답에 적으면 그 항목은 다시 묻지 않는다. 적지 않은 항목만 하나씩, 그 도구의 어휘로 묻는다(도구: Codex / Claude Code 선택, 모델: Claude Code는 `opus / sonnet / haiku / fable`, Codex는 로컬 Codex 카탈로그가 있으면 그 목록·없으면 이름 입력, 추론 수준: Claude Code `low … max`, Codex 카탈로그의 값, TIG: 금액). 추천·예상 금액·기본값은 없다. 예전처럼 로컬 AI가 request.md 초안을 쓰지 않는다 — request.md는 **내 답변**과 **프로젝트에서 읽은 사실**(브랜치·HEAD·변경 파일 수·최상위 구조·최근 커밋 제목·`package.json`/`requirements.txt`/`pyproject.toml`/`Cargo.toml`/`go.mod`/`Makefile`에서 감지한 설치·테스트 명령)로만 채운다. 카테고리는 요청 문장의 단어(버그/테스트/문서/설치/리뷰/리팩터/빌드/추가)로 정해지고 없으면 `other`다.

```text
› What should the worker do?
❯ 인증 미들웨어 리팩터링, claude / opus / high, 300 TIG
› When is this done?   (한 줄에 하나 또는 ; 로 구분, Enter = 요청 문장 그대로)
❯ 모든 라우트가 새 미들웨어를 거친다; 기존 테스트 통과
Worker AI: claude / opus / high · Done when: 모든 라우트가 새 미들웨어를 거친다 · 기존 테스트 통과
```

- **완료 기준(acceptance checks)은 내가 쓴다.** 수행자 결과가 오면 tig가 이 기준 하나하나에 대해 diff를 읽어 승인·보류를 판단하므로(`settle.ts`), 기준이 구체적일수록 정산이 정확하다. Enter면 요청 문장의 문장 단위가 기준이 된다.
- 조건을 문장 안에 섞어 쓰면(`gpt astra extrahigh로 1000 TIG`) 값은 읽되 문장은 그대로 두고, 끝에 붙인 조건절(`…, claude / opus / high, 300 TIG`)만 잘라낸다. 모델명은 검증하지 않는다(가용성은 수행자가 확인).
- 설명을 명령줄에 바로 주려면 `tig "로그인 버그 고쳐줘, codex / gpt-5 / high, 100 TIG"`.

**1-4. 요약 확인 → yes.** 내 답과 프로젝트 사실로 만든 request.md를 요약해 보여주고 묻는다. `yes`면 게시(새 공개 저장소 생성·TIG 예치), **`no`(아니요)는 "덧붙여 달라"**: `What should change?` 한 가지만 묻고, 답한 문장을 **요청 내용 끝에 이어 붙여**(AI 없음) 다시 준비한다. 새 요약에는 `Revised with: <문장>` 줄이 붙는다(이번 실행 안에서만). `details`면 request.md 전문, 목적지(새 저장소 이름)·트리 크기·새 파일 폴더별 개수·결과 가져오는 법, 변경·새·제외 파일 목록, `later`면 게시하지 않고 종료한다 — **`tig`는 실행할 때마다 새 요청**이라 다음 실행은 이전 내용을 이어받거나 보여 주지 않는다(준비된 request.md는 `tig request show <id>`로 스크립트에서만 볼 수 있다). **숫자만 치면 보상이 바뀌고**(예: `120`), `provider / model / effort`를 치면 수행자 AI가 바뀐다 — 같은 답으로 바로 다시 준비한다.

```text
◆ Is this the work you want to hand off?  review
인증 미들웨어 리팩터링
Work: 인증 미들웨어 리팩터링
Done so far: Recent commits: "Add auth middleware"; "Split router".
Done when: 모든 라우트가 새 미들웨어를 거친다 · 기존 테스트 통과
Worker AI: claude / opus / high — set by you (availability not verified)
Reward: 300 TIG — set by you · deadline 2026-09-24T02:39:47Z
Excluded: .env (protected)
› Publish publicly and reserve 300 TIG? (yes / no / details / later) [later]
❯ yes
```

**1-5. 게시 후.** 완료 화면에 `Repository:`(새 저장소 링크)·`Request:`(request.md 고정 커밋 링크)·`Task:`(웹 작업 링크)가 나온다. `yes`를 치는 순간 tig가 **내 GitHub 계정 아래에 새 공개 저장소**를 하나 만든다(`<login>/<폴더명>-tig-<YYYYMMDD-HHMM>-<요청 id 앞 6자>`; 요청마다 하나씩, 준비만 하고 `later`로 두면 만들어지지 않는다). 그 저장소의 `main`은 부모 없는 커밋 하나이고 내용은 **작업 트리 전체**에 루트의 `request.md`·`request.json`을 더한 것이다: git이 추적하는 파일 전부(커밋하지 않은 변경 포함) + **아직 `git add` 하지 않은 새 파일 전부**(폴더·확장자·크기와 무관하게, 데이터 파일과 실행 산출물도 — `.gitignore`에 걸리는 것만 빠진다). 올라가지 않는 것은 세 종류뿐이고 각각 사유와 함께 `Excluded:`(또는 `Held back`, `Tracked but left out`) 줄에 이름이 나온다: **보호 경로**(`.env`·키 파일·`credentials/`·`node_modules/`·`.venv/`·`*.log`·`.github/workflows/`), **비밀 패턴이 있는 파일**(비밀 게이트가 커밋의 바이트를 읽어 걸러낸다; 테스트 픽스처라서 올려야 하면 `include <경로>`로 이름을 대고 다음 화면에서 공개됨을 확인한다), 그리고 **있는 그대로 올릴 수 없는 파일**(LFS·심볼릭 링크·중첩 저장소·읽기 불가·삭제됨·100 MB 초과). 전체가 1 GB를 넘으면 게시하지 않는다. 플랫폼에는 두 문서만 등록되고 코드는 그 저장소로만 전달된다. 수행자의 결과는 그 저장소의 `main`을 base로 한 PR로 오므로, 받을 때는 내 프로젝트에서 `git fetch <저장소 URL>` 뒤 `git cherry-pick`으로 가져온다 — 요청 저장소는 내 트리의 사본이지 내 이력이 아니다. 요청 100건이면 저장소 100개가 생기며 지우는 것은 내 몫이다. 예전의 `code/` 묶음 방식은 `TIG_REQUEST_LAYOUT=bundle`로만 남아 있고, 예전 tig가 만든 프로젝트별 요청 저장소(`tig/requests/<id>` 브랜치)의 요청은 계속 읽힌다.

**1-6. 결과 검토.** 따로 확인하러 다닐 필요가 없다. 다음에 `tig`(또는 `tig work`)를 치면 마지막 이후 내 요청에 생긴 일이 마법사보다 먼저 한 줄씩 나오고(읽지 않은 것만, 최근 10개, 오래된 순, 없으면 아무 말 없음), 화면에 나온 것은 읽음으로 표시된다.

```text
14:02 · Your task was accepted — The worker has 10 minutes to start. → tig task 3f2a…
15:31 · Your result is ready — Open the result and review it within 48 hours. → tig task 3f2a… · tig approve 3f2a… --yes
```

터미널을 켜 두고 기다리려면 `tig work --watch`(2-3)를 요청자로 써도 된다: 로컬 AI가 없어 제안할 것이 없어도 꺼지지 않고, 10분마다 새 알림만 이어서 보여 준다(P-053: 알려 주기만 하고 승인·수락은 사용자가 친 명령으로만 일어난다).

```bash
tig task <id>             # 상태·검토 기한·PR 링크
tig result <id> --output result.json
tig approve <id> --yes    # 승인: 예치한 TIG 전액을 수행자에게 지급 (되돌릴 수 없음)
tig issue <id> --yes      # 문제 접수: 전액 환불하고 종료
tig inbox                 # 이미 읽은 것까지 전체 알림
```

웹의 해당 작업 화면에서도 같은 승인/문제 접수를 할 수 있다. 48시간 무응답이면 자동 지급된다. 수행자가 연 **Pull Request 병합은 지급과 별개**다. 코드를 요청 브랜치에 넣고 싶을 때만 GitHub에서 병합한다.

## 2. 수행자 (다른 컴퓨터, 다른 GitHub 계정)

**2-1. gh를 수행자 계정으로.** `gh auth status`의 Active account가 수행자 계정이어야 한다. 설치용으로 다른 계정을 썼다면 `gh auth login`으로 수행자 계정을 추가하고 `gh auth switch`. 결과 fork와 PR은 이 계정으로 만들어진다.

**2-2. 기기 연결.** 요청자와 같은 웹 주소에 연결한다.

```bash
tig connect --origin https://<website> --name <이 컴퓨터 이름>
```

링크를 브라우저에서 열 때 **수행자 GitHub 계정으로 로그인**한다. 같은 브라우저에 요청자 계정이 로그인돼 있으면 시크릿 창을 쓴다. 10분 안에 코드를 확인하고 `Device connected.`까지 기다린다.

**2-3. tig가 작업을 골라 제안한다 — yes 한 번.**

```bash
tig work --market          # 지금 한 번 제안
tig work --watch           # 터미널을 켜 두면 10분마다 확인해서 여유가 있을 때만 제안
```

tig가 이 컴퓨터의 Codex/Claude Code 사용률을 읽고(Codex는 공식 app-server, Claude Code는 상태줄 캡처), 설치된 도구로 할 수 있는 열린 요청 중 **하나**를 고른다: 사용률이 80% 이상인 도구는 쓰지 않고, 여유(모든 창 30% 이하) 있는 도구·요청이 지정한 도구와 일치·보상·최신 순. 요청이 지정한 도구를 못 쓰면 다른 설치 도구로 대신한다고 제안문에 적는다.

```text
Take "Make div() return None on zero divisor and add pytest tests" for 50 TIG with Codex (gpt-5.6 / high)? — Codex 12%/20% used: usage to spare; the request asks for Codex.
› Run it now? (yes / next / no) [no]
❯ yes
```

`yes`면 이후는 전부 자동이다(P-025: yes 한 번이 수락·실행·수행내역서·Git 제출까지): 수락 → 시작 → 요청 브랜치를 이 컴퓨터의 **작업 공간**(`~/.local/share/tokenisgold/worker-trials/…/ws`)에 clone → 로컬 AI가 **그 checkout 안에서 직접 파일을 고친다**(최대 20분, 5분마다 heartbeat로 수락 유지; Codex는 자체 sandbox `workspace-write`로 작업 공간 밖에는 쓰지 못하고 네트워크가 없으며, Claude Code는 `--restricted`로 파일 도구가 작업 공간 안으로 한정되고 명령을 실행하지 않는다) → tig가 diff를 검사(`request.md`/`request.json` 변경은 원복, `.env`·`.github/workflows`·키 파일 같은 보호 경로는 커밋에서 빼고 `report.md`에 사유를 적음, 비밀 패턴이 보이면 push·제출 없이 중단) → 요청 커밋 위에 결과 커밋 → `tig/results/<id>` 브랜치를 요청자 저장소(push 권한 있을 때) 또는 **본인 fork**에 push → 요청 브랜치를 base로 **PR** 생성 → 플랫폼 제출(변경 파일이 텍스트 97개·900 KB 안이면 함께 올리고, 아니면 `report.md`만 올린다 — **변경 파일 검토는 PR에서 한다**). AI가 아무것도 바꾸지 않았으면 제출하지 않고 `Codex made no change; nothing submitted. Run tig work <id> to try again.`이라고만 알린다. `next`는 다른 요청, `no`는 이번엔 안 함. 수락에는 TIG 잔액이 필요 없다.

`--watch`는 여유가 없거나 맞는 요청이 없으면 그 이유를 한 줄로 알리고 기다리며, `no`라고 답하면 6시간 동안 다시 묻지 않는다(P-053). 알림이 자동 수락으로 이어지지는 않는다: 실행은 반드시 `yes` 뒤에만 시작한다. Ctrl+C로 끝낸다. 특정 요청을 직접 지정하려면 `tig work <task-id>`(이때는 도구 선택과 수락 확인을 묻는다).

**`yes` 뒤 작업이 실패하면.** 제안을 띄운 채 자리를 비운 사이 다른 수행자가 먼저 수락했거나, AI가 20분을 넘겼거나, push/PR에 실패하면 `--watch`는 꺼지지 않고 한 줄로 알린 뒤 계속 지켜본다.

```text
08:40 · "Fix div() zero divisor" was not finished: This request is claimed and cannot be accepted. It is set aside; I'll keep watching for other requests. Next check in 10 min; I'll speak up when that changes.
08:40 · "Fix div() zero divisor" was not finished: Codex timed out after 20 minutes. It is accepted for you; run tig work 3f2a… to continue and submit it. Next check in 10 min; I'll speak up when that changes.
```

수락 전에 실패한 요청은 이번 watch에서 다시 제안하지 않는다(다른 작업을 마치면 다시 후보가 된다). 수락 뒤에 실패했다면 그 요청은 30분 동안 내 것이므로 다른 터미널에서 `tig work <task-id>`로 이어서 제출한다(중단된 상태면 `tig resume <task-id>` 뒤 `tig work <task-id>`); 그동안 watch는 `you are already working on "…" (executing); run tig work <task-id> to continue and submit it`라고만 알리고 새 제안을 하지 않는다. `tig work --market`(한 번 제안)은 이런 오류로 그냥 끝난다(exit 1).

**다른 도구로 대신할 때의 모델.** 요청이 지정한 도구를 못 써서 다른 도구가 대신하면 요청의 모델 이름은 그 도구에 없으므로, Codex는 공식 모델 목록의 현재 모델을 요청한 추론 수준(지원하지 않으면 기본 수준)으로, Claude Code는 기본 모델 `opus`를 같은 추론 수준으로 쓴다. 화면에 `Substituting Claude Code opus / medium with Codex gpt-5.6 / medium`처럼 미리 적고, 제출 기록에도 실제 사용한 도구·모델이 남는다(P-052: 조용한 대체 없음).

**실행 중 한도에 걸리면.** 로컬 AI가 "session limit"·"usage limit" 같은 메시지로 거부하면 tig는 그 도구의 reset 시각(예: `resets 11:30am (UTC)`)을 이 컴퓨터에만 기록하고, 다른 도구가 설치돼 있으면 `Claude Code hit its limit (resets 11:30 UTC). Run this request with Codex instead?`라고 한 번 묻는다. `yes`면 위 규칙대로 대신 실행하고, `no`면 수락은 30분 동안 유지되니 reset 뒤 `tig work <id>`로 이어서 한다. 기록된 한도는 reset까지 `--market`/`--watch` 제안과 요청자 초안 작성에서 그 도구를 빼는 데 쓰인다.

**2-4. 끝난 뒤.** 상태는 `AWAITING_REVIEW`. 수행자가 승인할 수는 없다. 요청자가 승인(또는 48시간 경과)하면 그 사실이 이 터미널로 온다: `--watch`를 켜 둔 채면 다음 확인 때 한 줄로, 아니면 다음에 `tig work`를 칠 때 맨 먼저(읽지 않은 것만, 화면에 나온 것은 읽음 처리).

```text
16:10 · Reward paid — 50 TIG was paid to the worker. → tig status
16:10 · Task refunded — 50 TIG was restored to the requester. → tig task 3f2a…
09:00 · Task available again — The previous execution permission ended. Check the latest task status. → tig work 3f2a…
```

```bash
tig task <id>     # 상태·검토 기한
tig status        # 지갑 잔액 (지급되면 available에 더해진다)
tig inbox         # 이미 읽은 것까지 전체 알림
```

수락 후 10분 안에 시작하지 않으면 수락이 풀리고, 실행 중 30분 동안 진행 신호가 없으면 요청이 다시 열린다.

## 3. Claude Code 화면에서 잔여량 보기 (선택)

```bash
tig claude-statusline install
```

Claude Code 창 하단에 `Tig · 5h 24% · 7d 41%`가 표시되고, 필수 한도 중 80% 이상 사용이면 `run tig to hand off the rest`, 모든 한도가 30% 이하이면 `tig work --market earns TIG`를 덧붙인다(P-053). 기존 상태줄이 있으면 그 위에 그대로 두고 tig 줄만 추가한다. 저장하는 값은 5시간/7일 사용률과 reset 시각뿐이다. 되돌리기: `tig claude-statusline uninstall`. 서버에 관측을 보내려면 `tig sync-claude`(Codex는 `tig sync-codex`).

## 4. 오늘 겪은 문제와 답

| 화면                                              | 원인                                                 | 답                                                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot reach http://…` / 예전엔 `fetch failed`   | 설치본 기본 주소(개발용)에 붙으려 했거나 서버가 꺼짐 | `tig connect --origin https://<website>`로 실제 주소에 연결                                                                         |
| `The code was not confirmed within 10 minutes`    | 링크를 늦게 열었거나 터미널을 Ctrl-C로 끊음          | 다시 `tig connect`, 링크를 바로 열고 터미널은 두기                                                                                  |
| `Could not resolve to a Repository … TaskHub`     | 로그인한 GitHub 계정에 private 저장소 권한 없음      | 권한 있는 계정으로 clone·설치 후 `gh auth switch`로 수행자 계정 복귀                                                                |
| `REVIEW_CLOSED: This task is not awaiting review` | 이미 웹에서 승인됨(중복 정산 방지)                   | `tig task <id>`로 PAID 확인                                                                                                         |
| 로그인 뒤 TIG 0                                   | 구독 자격이 아직 기록되지 않음                       | 검증 단계에서는 운영자가 자격을 기록한다([TH-030 검증](verification/TH-030-cross-machine-cycle.md)); 수행자는 잔액 없이도 수락 가능 |
