# Tokenisgold 요청자: tig 하나로 게시하기

기본 사용법은 `tig`다. 처음 연결을 기억하고 폴더 확인 → 작업·조건 입력 → 요약 확인 → 새 공개 저장소 생성·Git 업로드·웹 게시를 이어서 안내한다. 화면 문구는 영어이고 답은 한국어로 해도 된다. 전체 흐름과 화면 예시는 [사용 안내](USER_GUIDE.md) 1장을 따른다.

## 시작

VS Code에서 **작업할 프로젝트 폴더**를 열고 터미널에 입력한다.

```bash
tig
```

명령을 못 찾는 이 서버에서는 `~/.local/bin/tig`로 실행할 수 있다. 다른 컴퓨터는 Node 24에서 `npm ci`와 `npm run cli:install`로 설치한다. CLI를 npm 공개 레지스트리에 출시한 상태는 아니다. Git과 GitHub CLI가 필요하며 미설치는 화면에 공식 설치 링크를 안내한다. 요청자 쪽에서는 로컬 AI(Codex·Claude Code)를 부르지 않으므로 설치돼 있지 않아도 된다(수행자 도구를 Codex로 고르고 모델을 적지 않았을 때만 로컬 Codex의 모델 목록을 읽어 보여 준다). `tig doctor`가 준비 상태를 한 표로 보여준다. 비대화형 stdin/stdout에서는 멈춰 기다리는 대신 안내를 출력한다. 스크립트용 명령은 [고급 명령](REQUESTER_ADVANCED.md)을 따른다.

## 처음 한 번

1. **폴더 확인.** tig가 후보 폴더(지금 폴더가 Git 프로젝트면 그것, 아니면 최근 로컬 AI 세션의 프로젝트, 아니면 마지막 tig 프로젝트)를 보여 주고 `Is this the folder to hand off?`를 묻는다. Enter=yes. `no`면 경로나 프로젝트 이름을 받는다. Git이 없는 폴더는 초기화 여부를 묻고, 커밋 이름/이메일이 없으면 입력받는다. 빈 Git 저장소에는 빈 시작 커밋을 만든다.
2. TIG가 설치본에 설정된 웹 주소를 사용한다. 지금 로컬 앱은 `http://localhost:4173`이며 앱 실행은 `bash scripts/dev-local.sh`다. 원격 VS Code에서는 해당 포트를 전달하고 로컬 브라우저로 연다.
3. 표시된 웹 주소/기기 코드를 확인하고 로그인한 웹에서 연결을 승인한다.
4. **GitHub 계정 확인(매 실행).** `GitHub: signed in as <계정>. Publish requests under github.com/<계정>?` — Enter면 그 계정, `no`면 공식 로그인 흐름을 열어 다른 계정으로 로그인한 뒤 다시 묻는다. 로그인이 없으면 먼저 로그인을 연다. 비밀번호/토큰을 TIG에 입력하지 않는다. 요청 저장소는 확인한 계정 아래에 만들어진다. 이어서 Codex·Claude Code 설치·로그인 상태를 확인하고 로그인이 안 됐으면 공식 로그인을 열어 준다.

이후에는 같은 계정/프로젝트의 연결 질문을 생략한다. 폴더 확인과 작업·조건 입력은 실행할 때마다 한다 — 매 실행이 새 요청이다. 만료·연결 해제·계정/서버 변경은 다시 연결이 필요하다. 설정 변경은 `tig setup`.

## 평소 화면 예시

```text
◆ Your next task starts here  TOKENISGOLD
Project: /work/my-app — the folder tig was started in.
› Is this the folder to hand off? (yes/no) [yes]
❯ [Enter]
✓ my-app · 1500.00 TIG available · each request becomes a new public repository under github.com/yuchan

› What should the worker do?
❯ 로그인 오류를 고쳐줘, codex / gpt-5 / high, 1000 TIG
› When is this done?
❯ 로그인 화면에서 잘못된 비밀번호를 넣으면 오류 메시지가 보인다; 기존 테스트 통과
Worker AI: codex / gpt-5 / high · Done when: 로그인 화면에서 … · 기존 테스트 통과

◆ Is this the work you want to hand off?  review
로그인 오류를 고쳐줘
Work: 로그인 오류를 고쳐줘
Done so far: Recent commits: "Add login form".
Done when: 로그인 화면에서 잘못된 비밀번호를 넣으면 오류 메시지가 보인다 · 기존 테스트 통과
Worker AI: codex / gpt-5 / high — set by you (availability not verified)
Reward: 1000 TIG — set by you · deadline [24시간 뒤]
Excluded: .env (protected)
› Publish publicly and reserve 1000 TIG? (yes / no / details / later) [later]
❯ 네

◆ Your request is live  complete
✓ New public repository github.com/yuchan/my-app-tig-20260923-1102-8a1f30 created; your project and request.md are on its main branch
✓ 1000 TIG reserved
Repository: https://github.com/yuchan/my-app-tig-20260923-1102-8a1f30
Request: [GitHub 고정 커밋 request.md 링크]
Task: [웹 작업 링크]
```

**질문은 최대 여섯 개**(폴더, 작업, 도구, 모델, 추론 수준, TIG, 완료 기준 중 답에 없는 것만)이고, tig가 대신 정하는 값은 없다. 작업 문장에 `codex / gpt-5 / high, 1000 TIG`처럼 조건을 같이 적으면 그 항목은 묻지 않는다. 모델·추론 수준은 도구의 어휘를 쓴다(Claude Code: `opus / sonnet / haiku / fable`, `low / medium / high / xhigh / max`; Codex: 로컬 카탈로그의 모델과 `low … ultra`). `extra high`, `최대` 같은 표기도 정식 이름으로 바꿔 적는다. `Ultracode`는 Claude Code의 작업 모드이지 추론 수준이 아니라 받지 않는다.

마지막 질문은 게시 여부다. `yes`/`네`/`publish`/`올려줘`는 게시, `details`/`자세히`는 request.md 전문·목적지(새 저장소 이름)·트리 크기·파일 목록 보기, `later`/`나중에`/Enter는 게시하지 않고 종료(**`tig`는 실행할 때마다 새 요청**이며 이전 실행의 내용을 이어받지 않는다), `no`/`아니요`는 바꿀 점을 한 줄 받아 요청 내용에 덧붙여 다시 준비, 숫자는 보상 변경, `provider / model / effort`는 수행자 AI 변경, `new`/`새 요청`은 현재 요청을 내려두고 새로 시작이다. 명확한 TIG 보상이 요청에 있으면 그대로 쓰고, 없거나 모호하면(`100 TIG 아니고 200 TIG`) 반드시 묻는다. 커밋 제목·파일 이름에 있는 금액은 보상으로 쓰지 않는다. 표시한 수행자 모델은 요청 조건이며 사용 가능/실제 실행 증명이 아니다.

## 무엇이 올라가는가

- **작업 트리 전체**: 추적 파일(커밋 안 한 변경 포함)과 **모든 새 파일** — 폴더·확장자·크기와 무관하게, 데이터 파일과 실행 산출물도 함께. `.gitignore`에 걸리는 파일만 빠진다. 새 파일에 대해 묻지 않는다.
- 빠지는 것과 그 사유는 화면에 이름으로 나온다: 보호 경로(`.env`·키·`credentials/`·`node_modules/`·`.venv/`·`*.log`·`.github/workflows/`), 비밀 패턴이 있는 파일(`Held back` — 픽스처라서 필요하면 `include <경로>`), LFS·심볼릭 링크·중첩 저장소·읽기 불가·삭제·100 MB 초과. 전체 1 GB 초과는 게시하지 않는다.
- 요청마다 **새 공개 저장소** `<login>/<폴더명>-tig-<날짜-시각>-<id 앞 6자>`가 만들어지고 요청 커밋이 그 `main`이다. `later`로 끝낸 요청은 저장소를 만들지 않고, 다음 실행에 이어지지도 않는다. 수행자 결과는 그 저장소 `main`을 base로 한 PR로 오며, 내 프로젝트에는 `git fetch <저장소 URL>` 뒤 `git cherry-pick`으로 가져온다. 저장소 정리는 내 몫이다.
- Git push와 플랫폼 등록은 단일 트랜잭션이 아니다. 중간 오류는 같은 요청으로 재시도하며, 이미 만든 저장소와 push된 커밋을 다시 쓴다(두 번째 저장소를 만들지 않는다). 준비된 로컬 요청을 지워도 이미 공개된 저장소는 지워지지 않는다.
- `/cancel` 또는 Ctrl+C로 중단한다. 게시를 선택한 뒤 진행 중인 Git/서버 처리는 완료됐을 수 있으므로 다음 실행에서 상태를 확인한다.

## 실제 구현과 남은 것

요청자 흐름은 로컬 AI를 호출하지 않는다. request.md는 요청자의 답과 프로젝트 사실(`apps/cli/src/request-facts.ts`)로 작성되고, 조건 읽기는 `apps/cli/src/request-terms.ts`가 한다. 기존 AI가 작성한 JSON으로 진행하는 고급 경로(`tig instructions` → `tig request prepare/publish`)는 유지되며 같은 저장소 규칙을 따른다. 수행자 체험(`tig work`)은 로컬 Codex/Claude Code 어댑터를 쓴다([수행자 사용법](WORKER_QUICKSTART.md)).

검증은 로컬 Git remote·HTTP·DB를 사용하되 GitHub 경계는 대체했다. 실제 GitHub 저장소 생성·게시, Windows/macOS 네이티브 검증은 별도다. 수행자 AI 실행과 마켓 자동 매칭/외부 서비스 배포 완료를 의미하지 않는다. [검증 기록](verification/TH-034-interactive-requester.md).
