# Tokenisgold (tig) 사용 안내서

> 목적: 터미널에서 무엇을 어떤 순서로 치면 되는지만 정리한 문서다. 서버 접속 → 요청자 → 수행자 순서로 되어 있고, 각 장은 붙여넣어 그대로 실행할 수 있는 블록으로 구성했다.
>
> 읽는 법: 처음이면 1장을 한 번 끝내고, 그 다음부터는 자기 역할에 맞는 장(2장 또는 3장)만 보면 된다. 화면 예시는 실제 출력에서 핵심 줄만 추린 것이라, 실제 화면은 이보다 몇 줄 더 길다.

---

## Quick Read

tig는 AI 코딩 도구의 남는 구독 사용량을 교환하는 CLI다. 사용량이 떨어진 사람이 하던 작업을 통째로 넘기면, 여유 있는 사람이 자기 Codex / Claude Code로 대신 돌려주고 TIG를 받는다.

| 역할               | 결국 치는 명령                                                |
| ------------------ | ------------------------------------------------------------- |
| 처음 한 번         | `tig connect --origin https://<website> --name <컴퓨터 이름>` |
| 요청자             | `cd <프로젝트> && tig` → 요약 보고 `yes`                      |
| 수행자             | `tig work --market` → 제안 보고 `yes`                         |
| 요청자 (결과 받고) | `tig approve <task-id> --yes`                                 |

**요청자가 `yes`를 치면 그 프로젝트의 작업 트리 전체가 공개 GitHub 브랜치로 올라간다.** 커밋하지 않은 수정분과 새 파일도 함께 간다. 되돌리는 명령은 없다. 무엇이 올라가는지는 2.5를 먼저 읽는다.

서버 주소는 `https://unsoiled-empty-canal.ngrok-free.dev`다. 아래에서 `<website>`는 전부 이 주소를 뜻한다. CLI는 이 주소를 알려주지 않으니, 잃어버리면 운영자에게 다시 물어야 한다.

---

## 1. 서버 접속

### 1.1 준비물

- **`tokenisgold-cli-0.5.0.tgz` 파일** — 운영자에게 받는다. **저장소를 clone해서 직접 빌드하면 안 된다.** 이 안내서가 설명하는 기능(작업 폴더를 통째로 발행하는 것, 수행자 쪽 자동 실행)이 아직 원격 브랜치에 올라가 있지 않기 때문이다. clone하면 그 기능이 없는 예전 CLI가 나오고, 그 CLI는 작업을 수락하는 단계에서 서버가 `CLIENT_UPGRADE_REQUIRED`로 거절한다. 코드가 push되면 이 제한은 없어지고 `clone → npm ci → npm run build`로도 된다.
- **GitHub 계정** — tig 계정이 GitHub 계정과 1:1이고, 요청은 GitHub 저장소로 올라간다.
- **Codex 또는 Claude Code** — **둘 중 하나만** 있으면 된다. 둘 다 있으면 tig가 사용량을 보고 알아서 고른다.
- **그 도구의 유료 구독** — tig는 구독 로그인만 쓴다. API 키로는 안 된다.
- **git** — 없으면 tig가 `Install Git from https://git-scm.com/downloads, then run tig again.`으로 멈춘다.
- 요청자는 추가로 **git 저장소인 프로젝트 폴더**가 필요하다. 커밋이 하나도 없으면 tig가 빈 시작 커밋을 하나 만든다(파일은 건드리지 않는다).

1~3장에는 sudo도 docker도 필요 없다. 전부 `$HOME` 안에서 끝난다.

### 1.2 설치

받은 `.tgz`를 `~/Downloads/`에 두고 아래를 위에서 아래로 실행한다. **Linux + bash 기준이다.** macOS는 3)번을 `brew install gh`로 바꾸고, Windows는 WSL(Ubuntu)을 설치해 그 안에서 이 문서를 따른다. zsh면 `~/.bashrc`를 `~/.zshrc`로 바꾼다.

```bash
# ── 0) 프로필 파일 보장 ───────────────────────────────────────────────
touch ~/.bashrc                   # 없으면 nvm이 로더를 안 써넣고 조용히 넘어간다

# ── 1) Node 24 ────────────────────────────────────────────────────────
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install 24
nvm alias default 24              # 빼먹으면 새 터미널에서 tig가 사라진다
node -v                           # v24.x

# ── 2) PATH (gh를 넣을 자리) ──────────────────────────────────────────
mkdir -p ~/.local/bin
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.local/bin:$PATH"

# ── 3) GitHub CLI (2.21 이상) ─────────────────────────────────────────
case "$(uname -m)" in x86_64) GH_ARCH=amd64 ;; aarch64|arm64) GH_ARCH=arm64 ;; esac
GH_VER=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest \
  | sed -n 's/.*"tag_name": "v\([^"]*\)".*/\1/p')
curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VER}/gh_${GH_VER}_linux_${GH_ARCH}.tar.gz" \
  | tar -xz -C /tmp
install -m 755 "/tmp/gh_${GH_VER}_linux_${GH_ARCH}/bin/gh" ~/.local/bin/gh
gh auth login                     # GitHub.com → HTTPS → 브라우저 로그인

# ── 4) 로컬 AI — 둘 중 하나 ───────────────────────────────────────────
npm install -g @anthropic-ai/claude-code && claude auth login
# npm install -g @openai/codex && codex login

# ── 5) tig 설치 ───────────────────────────────────────────────────────
npm install --global ~/Downloads/tokenisgold-cli-0.5.0.tgz
tig --version                     # 0.5.0
```

한 줄이라도 빨간 글씨가 나오면 다음 줄로 넘어가지 말고 그 줄부터 다시 한다. 다 끝나면 **새 터미널을 열어** `tig --version`과 `node -v`를 다시 친다. 여기서 없다고 나오면 `~/.bashrc`에 nvm 로더 두 줄(`export NVM_DIR=…` / `[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"`)이 있는지 확인한다.

### 1.3 계정 연결

이 컴퓨터를 내 Tokenisgold 계정에 묶는다. **한 번만** 하면 된다.

먼저 브라우저를 준비한다. tig 계정은 GitHub 계정과 1:1이라, **연결할 GitHub 계정으로 로그인된 브라우저**에서 승인해야 한다. 다른 계정이 로그인돼 있으면 시크릿 창을 연다.

```bash
tig connect --origin https://unsoiled-empty-canal.ngrok-free.dev --name my-laptop
```

`--name`은 생략해도 된다(기본값은 이 컴퓨터의 호스트명). `--origin`은 생략할 수 없다.

터미널이 코드를 띄우고 **기다린다.** 닫지 말고 브라우저에서 승인한다.

```text
Open https://<website>/?connect=A1B2C3D4E5F6
Confirm code A1B2C3D4E5F6 on your signed-in web page.
The code expires in 10 minutes. Keep this terminal open until it says "Device connected."
```

| 순서 | 할 일                                   |
| ---- | --------------------------------------- |
| 1    | 출력된 링크를 브라우저에서 연다         |
| 2    | ngrok 경고 페이지가 뜨면 **Visit Site** |
| 3    | **Continue with GitHub** 로 로그인      |
| 4    | 코드를 확인하고 **Approve device**      |

승인되면 터미널이 `Device connected.`를 출력하고 끝난다. 승인 모달이 안 뜨면(첫 로그인이면 리다이렉트 중에 코드가 날아간다) 링크를 다시 열거나, 웹 상단 **Connections → Enter a connection code**에 코드를 붙여넣는다.

10분을 넘기면 이렇게 끝난다. `tig connect`를 다시 실행해 **새 코드**로 진행한다.

```text
The code was not confirmed within 10 minutes. Run tig connect again and confirm the new code while this terminal waits.
```

**한 컴퓨터에는 tig 계정이 하나만 묶인다.** `tig connect`를 다시 실행하면 이전 연결이 말없이 덮어써진다. 요청자와 수행자를 겸하려면 컴퓨터를 나누는 것이 안전하다(3.1).

### 1.4 확인

```bash
tig doctor
```

```text
  ✓ Node.js      v24.20.0
  ✓ Git          2.34.1
  ✓ GitHub CLI   2.100.0, signed in as rhkim00
  ✓ Claude Code  2.1.273, signed in with your subscription
  ✓ Codex        0.154.0, signed in with your subscription
  ✓ Tokenisgold  https://<website> as rhkim00
  · Execution    inside the task workspace: Codex --sandbox workspace-write (no network) · Claude Code --restricted (file tools only, no commands)
  · Isolation    bwrap available (Namespace probe passed; CPU/memory/network and credential-broker execution tests are still required.)

  Ready. Run tig to post a request, or tig work --market to earn TIG.
```

| 기호 | 뜻                                                             |
| ---- | -------------------------------------------------------------- |
| `✓`  | 정상                                                           |
| `·`  | 정보이거나 없어도 되는 항목. **실패가 아니다** — 그냥 넘어간다 |
| `✗`  | 고쳐야 한다. 바로 아래에 실행할 명령이 `→`로 붙는다            |

AI 도구를 하나만 깔았으면 나머지 하나는 `·`로 나온다. 마지막 줄이 `Ready.`면 끝이다. `✗`가 있으면 마지막 줄이 `Fix the items marked ✗, then run tig doctor again.`이다.

### 1.5 TIG 잔액

검증 기간에는 운영자가 손으로 넣어준다. 새 계정은 **0 TIG**로 시작한다.

- **수행자는 잔액이 필요 없다.** 0이어도 작업을 받아 일하고 보상을 받는다.
- **요청자는 요청을 올리기 전에 잔액을 받아 둔다.** 잔액이 모자란 채로 `yes`를 치면 **코드가 공개로 push된 뒤에** 등록이 `INSUFFICIENT_TIG`로 실패한다.

순서가 중요하다. **먼저 웹(`https://<website>`)에서 GitHub로 한 번 로그인을 끝내고**, 그 다음 운영자에게 GitHub 로그인명을 알려준다. 로그인 전에는 발행이 되지 않는다.

---

## 2. 요청자 — 작업 넘기기

### 2.1 실행

사용량이 떨어져 작업이 멈췄을 때, **하던 폴더에서** 친다. 그 폴더는 **이미 git 저장소여야 한다.**

```bash
cd <작업 중인 프로젝트>
tig
```

git 저장소가 아닌 폴더에서 치면 tig는 **최근 로컬 AI 세션이 있던 다른 프로젝트**를 골라서 진행한다. 화면의 `Project: …` 줄이 내가 넘기려던 폴더인지 반드시 확인한다. 아니면 Ctrl+C로 멈추고 맞는 폴더에서 다시 친다.

넘길 일을 따로 설명하지 않는다. tig가 최근 커밋·바뀐 파일·마지막 AI 세션을 읽어 인수인계 문서를 대신 쓴다. 로컬 AI를 한 번 부르므로 1~2분 걸리고, 3분을 넘기면 `Local AI timed out.`으로 끊긴다(그때는 `tig --select-files`로 파일을 줄여서 다시 친다).

**첫 실행에서는 요약 화면 전에 질문이 몇 개 더 나온다.** 전부 Enter나 `yes`로 넘어가도 되지만, 두 번째 질문은 값을 잘 고른다.

| 질문                                                                | 답                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------ |
| `This folder has no Git repository. Initialize Git here?`           | 의도한 폴더가 맞을 때만 `yes`                          |
| `Your name on shared code (Git author; …)`                          | **공개 커밋에 남는다**                                 |
| `Email for request commits (visible in the public delivery commit)` | **공개 커밋에 남는다.** 회사 메일을 무심코 넣지 않는다 |
| `Open the official GitHub sign-in flow?`                            | `yes` (gh 로그인이 없을 때만)                          |
| `Include these new files in the request? …`                         | 새 파일 공개 여부. 목록을 보고 고른다                  |
| `One detail check before drafting: …`                               | Enter만 쳐도 된다                                      |

또 하나, 첫 실행은 내 GitHub 계정에 **`<프로젝트이름>-tig-requests`라는 새 PUBLIC 저장소를 질문 없이 만든다.** 프로젝트의 `origin`이 이미 공개이고 push 권한이 있으면 그 저장소를 그대로 쓴다 — 그 경우 요청 브랜치가 **본 프로젝트 저장소에 생기고 협업자 전원에게 보인다.** 다른 곳에 올리려면 먼저 `tig setup`을 친다.

### 2.2 요약 화면

```text
  ◆ Is this the work you want to hand off?  review

  div()의 0 나눗셈 처리를 끝내고 pytest 테스트를 추가
  Work: ⟨무엇을 해야 하는지⟩
  Done so far: ⟨지금까지 된 것⟩
  Done when: ⟨완료 조건 1⟩ · ⟨완료 조건 2⟩ · ⟨완료 조건 3⟩
  Worker AI: claude / opus / medium — ⟨고른 이유⟩
  Reward: 150 TIG — feature request, small (5 shared files) · deadline 2026-09-18T04:12:00Z
  Destination: github.com/rhkim00/myproject-tig-requests (request repository) · branch tig/requests/⟨id⟩
  Tree: 6 files (257 B) = HEAD + 1 changed + 2 new: newmod/helpers.py, newmod/requirements.txt
  › Publish publicly and reserve 150 TIG? (yes / no / details / later) [later]
  ❯ yes
```

실제 화면은 이보다 길다. `Tree:` 줄 아래에 **빠진 파일과 그 사유가 줄마다 붙고**(`Left out, not in git:`, `Tracked but left out:`, `Excluded:`), 그 뒤에 결과를 가져오는 방법과 입력 안내가 더 나온다. 그 줄들이 실제로 무엇이 공개되는지 말해주는 부분이니 `yes` 전에 한 번 읽는다.

읽을 때 세 줄만 확인하면 된다.

- `Destination:` — 여기로 공개된다. `(request repository)`면 tig가 만든 요청 저장소, `(your repository)`면 **내 프로젝트 저장소 그 자체**다.
- `Reward: … · deadline …` — deadline은 **수행자가 이 요청을 가져가야 하는 기한**(게시 +24시간)이다. 그때까지 아무도 안 가져가면 요청이 닫히고 예치한 TIG는 전액 환불된다.
- `Worker AI:` — 요청자가 고른 값이고, 수행자 쪽에 그 모델이 실제로 있는지는 확인하지 않는다.

여기서 칠 수 있는 것은 이게 전부다.

| 입력                   | 결과                                                   |
| ---------------------- | ------------------------------------------------------ |
| `yes`                  | 게시. 프로젝트가 공개 브랜치로 올라가고 TIG가 예치된다 |
| `no`                   | 무엇을 바꿀지 한 줄 말하면 request.md를 다시 쓴다      |
| `details`              | request.md 전문과 파일 목록                            |
| `later` 또는 Enter     | 보관. 다음 `tig`에서 이 화면부터 시작한다              |
| `120` 같은 숫자        | 보상 금액 변경                                         |
| `claude / opus / high` | 수행자 AI 변경                                         |

`yes` 뒤 화면이다.

```text
  ◆ Your request is live  complete

  ✓ Branch tig/requests/⟨id⟩ uploaded to github.com/rhkim00/myproject-tig-requests
  ✓ 150 TIG reserved

  Task: https://<website>/?task=⟨task-id⟩
  Request: https://github.com/rhkim00/myproject-tig-requests/blob/⟨sha⟩/request.md
  You can follow this task on the website.
```

**`Task:` 링크를 저장해 둔다.** 게시 이후 진행 상황을 사람이 읽을 수 있게 보여주는 곳은 여기뿐이다.

### 2.3 내용이 다를 때 — no

tig가 쓴 내용이 내가 넘기려던 일과 다르면 `no`를 친다. 그때만 자연어로 한 줄 받는다.

```text
  › Publish publicly and reserve 150 TIG? (yes / no / details / later) [later]
  ❯ no
  › What should change? (describe it; Enter keeps the request)
  ❯ 테스트는 빼고 div() 수정만 해줘
  Rewriting request.md with Claude Code to apply your change (a new draft; the files and terms stay).
```

고친 내용으로 요약 화면이 다시 뜨고 `Revised with: ⟨지시⟩` 줄이 붙는다. 마음에 들 때까지 반복할 수 있고, Enter만 치면 원래 요청 그대로 돌아온다.

### 2.4 가끔 쓰는 것

```bash
tig --select-files              # 공개할 새 파일을 직접 고른다
tig setup                       # 목적지 저장소를 바꾼다
tig claude-notes install        # Claude Code 세션 내용을 초안에 쓰게 한다 (선택)
```

초안이 마지막 AI 대화를 전혀 반영하지 못하면 `tig claude-notes install`을 한 번 하고 Claude Code 세션을 한 번 돌린 뒤 다시 `tig`를 친다. 되돌리려면 `tig claude-notes uninstall`.

### 2.5 무엇이 올라가나

`yes` 전에 이 절을 읽는다. **게시를 취소하는 명령은 없다.** 잘못 올렸으면 GitHub에서 브랜치나 저장소를 손으로 지우고, 노출된 자격증명은 전부 교체해야 한다.

| 올라감                                                                         | 올라가지 않음                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **git이 추적하는 파일 전부** + 커밋 안 한 수정분                               | `.env`, 키 파일(`.pem` `.key` …), `credentials/`, `secrets/`        |
| 새로 만든 `.py` `.ts` `.md` 등 코드 — 어느 폴더에 있든                         | `node_modules`, `.venv`, `__pycache__`, `.git`, `.github/workflows` |
| `requirements.txt`, `Dockerfile` 등 프로젝트 파일                              | `*.log` (추적 여부와 무관하게 항상)                                 |
| **추적 중인 폴더(루트 포함)에 있는 1MB 이하의 새 파일 — 종류를 가리지 않는다** | **아직 `git add` 안 한** `.csv` `.pt` `.parquet` 등 데이터 파일     |
| 실행 권한, 바이너리                                                            | 비밀 문자열이 잡힌 파일, 1MB 넘는 **새** 파일, 심볼릭 링크, LFS     |

두 가지를 특히 조심한다.

- **git이 이미 추적 중인 데이터 파일은 그대로 공개된다.** 데이터 확장자 필터는 아직 `git add` 하지 않은 파일에만 걸린다. `git add data/train.csv`를 이미 한 저장소라면 그 CSV는 100MB까지 공개 브랜치로 나간다. 모델 체크포인트·DB 덤프도 같다.
- **프로젝트 루트에 둔 새 파일은 확장자를 가리지 않고 올라간다.** `notes.txt`, `이력서.pdf`, `고객명단.xlsx`, 스크린샷 전부 해당한다. 루트는 항상 "추적 중인 폴더"로 친다.

비밀 문자열 검사는 보조 수단이지 보증이 아니다. 정규식 휴리스틱이고, **10MB가 넘는 파일은 내용을 한 번도 읽지 않고 그대로 공개된다**(그 개수는 요약 화면에 나온다).

빠진 파일은 사유와 함께 요약 화면에 나온다. 그중 `Left out, not in git:`에 잡힌 것만 `git add` 후 다시 `tig`를 치면 올라간다. `Excluded:`에 잡힌 보호 경로(`.env`, 키, `*.log`, `.venv/` …)는 `git add`를 해도 계속 빠진다.

### 2.6 결과 받기

```bash
tig work --watch --every 10     # 이 터미널을 열어두면 수락·제출·지급 알림이 뜬다
tig inbox                       # 알림 목록 (JSON)
tig task <task-id>              # 상태 (JSON, PR 링크는 submission.gitResult.pullRequestUrl)
tig approve <task-id> --yes     # 승인 → TIG 지급 (확인 질문 없다. 되돌릴 수 없다)
tig issue <task-id> --yes       # 문제 접수 → 전액 환불하고 종료
```

`tig status`와 `tig task`는 원시 JSON을 그대로 찍는다. 잔액은 `wallet.available`, 상태는 `state` 필드를 본다. 사람이 읽기 좋은 화면은 게시 완료 화면의 `Task:` 링크(웹)다.

알림을 받겠다고 그냥 `tig`를 치면 안 된다 — 그건 새 요청을 만들기 시작한다.

**환불에는 기한이 있다.** 수행자가 제출한 순간부터 48시간 안에만 `tig issue`가 환불이다. 48시간이 지나면 자동 지급되고, 그 뒤에 친 `tig issue`도 **환불이 아니라 지급으로 처리되면서 오류 없이 성공한다.**

결과 코드를 내 프로젝트로 가져온다. 결과 브랜치는 내 프로젝트의 `origin`이 아니라 **요약 화면의 `Destination:`에 나온 저장소**에 있다.

```bash
# PR 링크가 있으면 이게 제일 쉽다 (링크는 tig task의 submission.gitResult.pullRequestUrl)
gh pr checkout <PR 링크>

# 직접 가져올 때 — <저장소>는 Destination 줄에 나온 그 저장소다
git fetch https://github.com/<계정>/<프로젝트>-tig-requests.git tig/results/<task-id>
git cherry-pick FETCH_HEAD      # tig/requests/* 는 main에 merge하지 않는다
```

수행자에게 그 저장소 push 권한이 없었으면 결과는 **수행자 본인의 fork**에 있다. 그때는 PR 페이지에서 받는다. 그리고 `tig/requests/<request-id>`와 `tig/results/<task-id>`는 **서로 다른 UUID**다. 요청 브랜치의 id를 여기에 붙여넣으면 `couldn't find remote ref`가 난다.

---

## 3. 수행자 — 작업 받기

### 3.1 계정 조건

**요청자와 다른 tig 계정**이어야 한다. 서버가 보는 것은 gh CLI 계정이 아니라 `tig connect`로 이 컴퓨터에 묶인 tig 계정이라, `gh auth switch`로는 바뀌지 않는다.

내 요청은 시장 목록에서 아예 걸러지므로, 자기 요청만 있으면 `no open requests from other users right now (your own requests are never proposed to you)`가 나온다.

이때 같은 컴퓨터에서 `tig connect`를 다시 하는 것은 권하지 않는다. **연결은 컴퓨터당 하나뿐이라 이전 계정 연결이 덮어써지고, 그러면 내가 올린 요청을 `tig approve`할 수 없게 된다.** 요청자와 수행자는 다른 컴퓨터에서 한다.

gh 계정은 다른 이유로 맞춰 둔다 — 결과 브랜치 push와 PR 작성자가 gh 계정이다.

```bash
gh auth status                       # Active account 확인
```

### 3.2 실행

```bash
tig work --market               # 지금 한 번 제안받기
tig work --watch --every 10     # 터미널에 띄워두고 여유 있을 때만 제안받기
tig work <task-id>              # 특정 작업 지정
```

`tig work <task-id>`에 **자기 요청 id**를 넣으면 제출 없는 개인 시험 실행이 된다. 남의 요청 id면 수락·실행·제출까지 간다.

### 3.3 제안 화면

```text
  Take "div() 0 나눗셈 처리" for 150.00 TIG with Claude Code (opus / medium)? — Claude 12%/20% used: usage to spare; the request asks for Claude Code.
  › Run it now? (yes / next / no) [no]
  ❯ yes
```

| 입력               | 결과                                            |
| ------------------ | ----------------------------------------------- |
| `yes` 또는 `네`    | 수락 → 실행 → PR → 제출까지 자동                |
| `next` 또는 `다음` | 건너뛰고 다른 요청                              |
| `no` 또는 Enter    | 이번엔 안 함 (`--watch`는 6시간 조용해진다)     |
| `stop` 또는 `그만` | `--watch` 종료 (`--market`에서는 조용히 끝난다) |

`yes`가 실제 결정 시점이다. 이 뒤로는 확인 질문이 없다.

- **내 Codex / Claude 구독 사용량이 소모된다.** 최대 20분어치다.
- 보상은 **요청자가 승인하거나, 제출 뒤 48시간 동안 응답하지 않을 때만** 지급된다. 그 48시간 안에 요청자가 `tig issue`를 치면 한 푼도 못 받는다.
- 요청 저장소에 push 권한이 없으면 tig가 `gh repo fork`를 돌려 **내 GitHub 계정에 공개 fork를 만든다.**

### 3.4 yes 뒤에는 손댈 것이 없다

tig가 순서대로 처리하고, 화면은 이 문구들로 바뀐다.

| 단계 | 화면                                                                           | 시간      |
| ---- | ------------------------------------------------------------------------------ | --------- |
| 1    | `Cloning tig/requests/<id> into a private workspace…`                          | 최대 10분 |
| 2    | `<도구> is implementing the request in the workspace…`                         | 최대 20분 |
| 3    | 변경 내용 검사 (보호 경로 제외, 비밀 문자열 검사)                              |           |
| 4~5  | `Publishing the result branch and pull request to the requester's repository…` |           |
| 6    | `Submitting your result for the requester's review…`                           |           |

```bash
tig task <task-id>              # AWAITING_REVIEW 확인 (JSON)
tig status                      # 지갑 잔액은 wallet.available
```

요청자가 승인하면 다음에 `tig`나 `tig work`를 칠 때 알림이 먼저 뜬다.

```text
  10:15 · Reward paid — 150.00 TIG was paid to the worker. → tig status
```

### 3.5 제안이 안 뜰 때

`--watch`는 사용량에 여유가 있을 때만 제안한다. Claude 사용량은 터미널 상태줄에서만 읽을 수 있어서 한 번 설치가 필요하다.

```bash
tig claude-statusline install --yes
# 그 뒤 터미널에서 Claude Code 세션을 한 번 실행하면 사용량이 잡힌다
```

되돌리려면 `tig claude-statusline uninstall`. 그동안은 `tig work --market`으로 직접 제안받으면 된다.

---

## 4. 문제 해결

| 증상                                                            | 해결                                                                                                                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tig: command not found`                                        | `nvm alias default 24` 확인 후 새 터미널. 그래도 없으면 `~/.bashrc`에 nvm 로더 두 줄이 있는지 보고 1.2 5)번을 다시 실행                                                                     |
| `gh: command not found`                                         | PATH에 `~/.local/bin`을 넣었는지 확인하고 새 터미널                                                                                                                                         |
| `Cannot reach https://…` / `… did not answer within 15 seconds` | 주소에 오타가 없는지, `http://localhost:4173`을 가리키고 있지 않은지 본다(그러면 `tig connect --origin <주소>`를 안 한 것이다). `tig doctor`로 확인하고, 주소가 맞는데도 안 되면 운영자에게 |
| `The code was not confirmed within 10 minutes`                  | `tig connect`를 다시 실행하고 **새 코드**로 승인                                                                                                                                            |
| 브라우저에 ngrok 경고 페이지                                    | **Visit Site**를 한 번 누르면 된다                                                                                                                                                          |
| 승인 모달이 안 뜬다                                             | 링크를 다시 열거나 **Connections → Enter a connection code**                                                                                                                                |
| `CLIENT_UPGRADE_REQUIRED`                                       | 운영자에게 최신 `.tgz`를 받아 다시 설치                                                                                                                                                     |
| `Local AI timed out.`                                           | 드래프트 3분 제한이다. `tig --select-files`로 파일을 줄여서 다시                                                                                                                            |
| `GitHub command failed. …`                                      | `gh auth status`와 `gh repo view <계정>/<저장소>`를 직접 쳐서 원인을 본다(로그인 만료 / 저장소 이름 충돌 / 권한 부족)                                                                       |
| `INSUFFICIENT_TIG`                                              | 잔액이 모자라다. **코드는 이미 공개됐다.** 운영자에게 TIG를 받고 같은 요청으로 재시도한다                                                                                                   |
| `you are already working on "…"`                                | 한 번에 한 작업만 가진다. `tig work <task-id>`로 그것부터 끝내고 제출                                                                                                                       |
| `no open requests from other users…`                            | 내 요청은 나에게 제안되지 않는다. 다른 계정·다른 컴퓨터가 필요하다                                                                                                                          |
| `--watch`가 계속 조용함                                         | `tig claude-statusline install --yes` 후 Claude Code 세션 한 번, 또는 `tig work --market`                                                                                                   |
| `yes` 뒤 작업 실패                                              | 화면이 이어갈 방법을 알려준다. 보통 `tig work <task-id>`                                                                                                                                    |
| `… made no change; nothing submitted.`                          | 작업은 아직 내 것이다. `tig work <task-id>`로 다시 돌린다                                                                                                                                   |
| `Could not clone the request branch …`                          | 요청 저장소가 비공개로 바뀌었을 수 있다. 요청자에게 확인                                                                                                                                    |
| 수행자: 실행 중 `… hit its limit`                               | 다른 도구로 바꾸겠냐는 질문에 `yes`. **거절하면 작업은 30분만 내 것이다** — reset이 그보다 늦으면 작업이 다른 수행자에게 넘어가고 쓴 사용량은 보상받지 못한다                               |
| 요청자: 드래프트 중 `… hit its limit`                           | tig가 다른 도구로 알아서 넘어간다. 대체 도구가 없으면 reset 뒤에 `tig`를 다시 친다                                                                                                          |

---

## 부록 A. 명령어 요약

| 명령                                           | 누가   | 하는 일                          |
| ---------------------------------------------- | ------ | -------------------------------- |
| `tig connect --origin <website> --name <이름>` | 공통   | 이 컴퓨터를 계정에 연결 (한 번)  |
| `tig doctor`                                   | 공통   | 준비 상태 점검                   |
| `tig status`                                   | 공통   | 계정·지갑 잔액 (JSON)            |
| `tig`                                          | 요청자 | 요청 만들기                      |
| `tig --select-files`                           | 요청자 | 공개할 새 파일 직접 선택         |
| `tig setup`                                    | 요청자 | 목적지 저장소 변경               |
| `tig claude-notes install`                     | 요청자 | 초안에 Claude 세션 반영 (선택)   |
| `tig inbox`                                    | 공통   | 알림 목록 (JSON)                 |
| `tig task <id>`                                | 공통   | 작업 상태 (JSON)                 |
| `tig approve <id> --yes`                       | 요청자 | 승인·지급                        |
| `tig issue <id> --yes`                         | 요청자 | 문제 접수·환불 (제출 +48시간 내) |
| `tig work --market`                            | 수행자 | 제안 한 번 받기                  |
| `tig work --watch --every <분>`                | 공통   | 상주하며 제안·알림받기           |
| `tig work <id>`                                | 수행자 | 특정 작업 수행                   |
| `tig claude-statusline install --yes`          | 수행자 | Claude 사용량 표시 설치          |

## 부록 B. 서버 운영 (운영자 전용)

> 여기부터는 서버를 띄우는 사람만 본다. 일반 사용자는 읽을 필요가 없다. ngrok 도메인과 GitHub OAuth callback이 한 계정에 묶여 있어서, 같은 주소를 다른 컴퓨터에서 동시에 띄울 수는 없다.

```bash
# 저장소 경로 복구 (/data1은 fstab에 없다)
mountpoint -q /data1 || sudo mount /dev/sdb1 /data1
cd /home/rhkim/TaskHub
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use

# DB → 터널 → 서버 (전부 setsid로 띄워야 VS Code를 닫아도 산다)
docker compose -f infra/dev/compose.yml up -d
setsid nohup ~/.local/bin/ngrok http --url=unsoiled-empty-canal.ngrok-free.dev 4320 \
  > ~/tig-ngrok.log 2>&1 < /dev/null &
setsid nohup bash .local/staging/start.sh > ~/tig-staging.log 2>&1 < /dev/null &

# 확인 — development:false, githubSignIn:true 면 정상
curl -s http://127.0.0.1:4320/v1/config

# 배포용 CLI 만들기 (서버 주소를 구워서 .tgz를 뽑는다)
TIG_RELEASE_ORIGIN=https://unsoiled-empty-canal.ngrok-free.dev npm run cli:pack
#   → .local/releases/tokenisgold-cli-0.5.0.tgz
#   이 파일과 서버 주소를 사용자에게 함께 전달한다 (주소는 CLI가 알려주지 않는다)

# TIG 발행 — 웹에서 GitHub 로그인을 한 번 마친 계정에만 된다
node --env-file=.local/staging/.env.staging --import tsx \
  .local/staging/verify-entitlement.mts <github-login> <codex|claude> <plan-id> <monthly-usd>
#   예: … rhkim00 claude max-5x 100  → 5,000 TIG, 이후 매주
```
