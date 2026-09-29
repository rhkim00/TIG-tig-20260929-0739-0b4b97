# 고급 명령: VS Code의 AI에서 Git 요청 게시하기

고급 명령 호환 경로 (0.3.0에서 도입): **자연어 요청 → 기존 AI가 명세 작성 → request.md·코드 준비 → 공유 확인 → Git 게시·TIG 예치 → 웹 확인**.
실제 수행자 AI 실행은 다음 단계이며, 이번 흐름에서 자동 코딩이 완료되지는 않는다. 륜호 참여 없이 유찬 혼자 요청자 흐름을 확인할 수 있다.

## 1. 한 번 연결

현재 서버에는 `~/.local/bin/tig` 0.5.0을 설치했다. 명령을 못 찾으면 `export PATH="$HOME/.local/bin:$PATH"`를 실행한다. 다른 컴퓨터는 Node 24에서 저장소의 `npm ci`, `npm run cli:install`을 사용한다. GitHub CLI도 필요하다.

웹 `http://localhost:4173`에서 요청자 계정으로 접속한다. 원격 VS Code라면 4173 포트를 전달한다. 개발 환경에서는 demo-requester로 연결하며 샘플 TIG를 사용한다.

```bash
tig connect --origin http://localhost:4173 --name "requester VS Code"
# 표시된 링크를 요청자 웹에서 열고 기기 코드 승인

gh auth login
# 이미 본인 GitHub에 로그인했다면 다시 로그인할 필요 없음
```

Tokenisgold 연결과 GitHub 로그인은 서로 다른 연결이다. 기존 두 역할 테스트를 쓴 경우 이 터미널의 TIG_STATE_DIR가 요청자 연결을 가리키는지 `tig status`로 먼저 확인한다.

## 2. 작업할 프로젝트에서 Git 연결

**TIG 서비스 개발 저장소가 아니라, 공유하려는 작은 테스트 프로젝트에서 먼저 시험한다.** 로컬 Git 커밋 한 개와 user.name/email 설정이 필요하다. 현재 패키지는 98개 소스 파일·전체 1 MB까지다.

```bash
cd /path/to/my-test-project

tig init --repository MY_GITHUB/tokenisgold-requests --install-instructions
```

MY_GITHUB를 본인 GitHub 아이디로 바꾼다. 이미 존재하는 본인 공개 저장소를 연결한다. 저장소가 없다면 먼저 공개 생성 안내를 확인한다.

```bash
tig init --repository MY_GITHUB/tokenisgold-requests --create
# 이름과 PUBLIC 표시 확인 후 공개 저장소 생성에 동의하면:
tig init --repository MY_GITHUB/tokenisgold-requests --create --yes --install-instructions
```

여기까지는 빈 전달 저장소 연결과 로컬 AI 안내 설치이며 코드 업로드가 아니다. TOKENISGOLD.md와 기존 AGENTS.md/CLAUDE.md의 참조 블록이 생긴다. 작업 프로젝트의 기존 지침은 보존한다. AI 세션에 새 안내를 읽도록 말한다.

## 3. 기존 AI에게 요청

> TOKENISGOLD.md와 `tig instructions`를 읽어줘. 이 프로젝트의 [구체적인 수정 내용]을 Tokenisgold에 올릴 수 있게 준비해줘. 보상은 100 TIG야. 지금까지 진행한 일과 다음 작업, 완료 조건을 명세에 담고, 모델·추론·기한 중 빠진 정보가 있으면 필요한 것만 물어봐. 공개할 파일과 request.md를 먼저 보여줘.

AI는 현재 대화·코드를 바탕으로 엄격한 명세 JSON을 **프로젝트 바깥 로컬 파일**에 작성한다. tig instructions 안에 전체 입력 예시가 있으므로 Tokenisgold 소스 문서를 따로 찾을 필요가 없다.

AI가 실행할 명령:

```bash
tig request prepare --spec /path/outside-project/request-input.json
# --include src/new-file.ts 는 초안 작성용 스냅샷에 넣을 미추적 파일이다.
# 기본 레이아웃(tree)에서 공개 브랜치에 올라가는 미추적 파일은 이 목록이 아니라
# 새-파일 규칙이 정한다. 실제로 무엇이 올라가는지는 아래 preview에서 확인한다.
```

결과에는 로컬 request.md 경로, 전체 공유 파일 목록, 제외/미선택 파일, 대상 공개 저장소, 모델 요구·100 TIG·기한·확인 digest가 나온다. VS Code에서 request.md와 snapshot/code/의 내용을 확인할 수 있다. 아직 GitHub에 올라가지 않았고 TIG도 예치되지 않았다.

미확인 Astra 같은 이름은 요구값일 뿐 지원 검증이 아니다. AI가 다른 모델로 몰래 대체하지 않는다.

## 4. 확인한 요청 게시

> 이 코드와 명세를 표시된 공개 저장소에 게시하고 100 TIG를 예치해줘.

AI가 출력된 **같은 요청 ID와 digest**로 실행한다.

```bash
tig request publish REQUEST_ID --approve PREVIEW_DIGEST --yes
```

내용·공개 공유 범위·보상이 이미 명확하게 승인됐다면 AI가 불필요하게 같은 승인을 다시 묻지 않는다. GitHub에 올라가는 구조:

```text
tig/requests/<요청ID> 브랜치
├── request.md       작업 목적·진행 상황·다음 작업·완료 조건
├── request.json     같은 명세의 구조화된 원본
└── code/            공유한 시점의 코드와 선택한 미커밋 변경
```

원본 프로젝트의 브랜치·스테이징·미커밋 수정은 그대로다. 원본 Git 과거 이력은 전달 저장소로 복제하지 않는다.

게시 성공 응답의 requestUrl로 정확한 Git 커밋을, taskUrl로 웹 작업을 확인한다. 웹에 **View request.md & code on GitHub** 링크가 나온다. 실제 거래 잔액/상태는 Git 파일이 아닌 서버 DB에 저장한다.

```bash
tig tasks --mine
tig task TASK_ID
tig request show REQUEST_ID
```

실패하면 **같은 publish 명령을 재시도**한다. 새 prepare는 새 요청이므로 재시도용으로 쓰지 않는다. Git push는 성공했지만 서버 등록이 실패할 수 있고 그 경우 Git은 이미 공개되어 있다. show로 진행 상황을 확인한다.

## 아직 남은 것

일반 작업 게시까지이며 수행자 실제 AI 실행/자동 추천/결과 PR·Apply changes는 후속이다. 현재 개발 로그인·샘플 TIG와 실제 외부 OAuth·구독 확인·공개 배포를 구분한다. 다른 OS 설치는 별도 검증이 필요하다. 정책·검사 세부는 [요청자 Git 계약](contracts/requester_git.md)을 따른다.
