# 유찬·륜호가 직접 거래 테스트하기

실제 프로젝트의 요청 명세를 Git에 게시하려면 [요청자 CLI 0.5.0 안내](REQUESTER_QUICKSTART.md)를 따른다. 아래 demo-post는 정해진 샘플 거래 테스트이며 현재 프로젝트를 인계하지 않는다.

Day 1~2 기반(모노레포·웹·API·PostgreSQL·기기 연결·원장)은 구현되어 있다. 이 문서는 그 위의 CLI 설치와 두 계정 거래 테스트다.
현재 제공하는 것은 **개발 환경의 샘플 TIG 거래**다. 실제 DB/HTTP/파일 검사/정산을 사용하지만 Codex·Claude에게 실제 코딩을 맡기지는 않는다. 일반 공개 저장소 작업의 실행은 runner 검증 전까지 차단한다. 실제 GitHub 로그인 등록과 구독 자격 확인도 별도 남은 작업이다.

## 가장 빠른 웹 테스트

이 서버의 앱 주소는 **http://localhost:4173**이다. DB와 앱은 TIG 폴더에서 실행한다. localhost는 웹을 여는 PC를 뜻하므로 원격 서버에서는 아래 포트 연결이 필요하다.

1. 유찬: 일반 브라우저로 열고 **Explore local preview**. 상단에 `demo-requester`인지 확인한다.
2. 륜호: 본인 브라우저(한 사람이 테스트하면 시크릿 창)로 같은 서버에 접속한다. **Switch preview account**를 눌러 상단을 `demo-worker`로 맞춘다. 각 창은 별도 쿠키 저장소를 사용한다.
3. 유찬: Overview → **Post local test · 100 TIG**. 100 TIG가 예치된다.
4. 륜호: Marketplace → **Update wallet labels · local test** → **Yes, accept this task** → **Start local test**.
5. 륜호: 미리 채워진 `wallet-labels.json`을 확인하고 **Submit result**. 일부 값을 바꾸면 서버가 필수 검사 실패를 보여주므로 정상 값으로 복구해 재제출할 수 있다.
6. 유찬: My tasks에서 해당 작업을 열어 파일·수행내역·검사 결과를 본다. **Approve & pay 100 TIG**를 누르면 수행자에게 지급된다. **Report an issue & refund**를 누르면 요청자의 100 TIG가 복구되고 종료된다.
7. 양쪽 Overview/Activity에서 잔액과 내역을 확인한다. 화면은 10초 주기로, 열린 작업 상세는 5초 주기로 갱신한다. 새로고침해도 같은 상태다.

검토 기한은 서버의 필수 검사 완료 및 제출 저장 시점부터 정확히 48시간이다. 무응답이면 Worker가 자동 지급한다. 기한과 정확히 같은 시각부터 자동 지급이 우선하며 지급 후 신고가 자동 환불로 처리되지는 않는다. 로컬에서도 **서버의 Worker 프로세스가 실행 중이어야** 예약 정산이 된다.

수락 후 10분 내 시작하지 않으면 수락이 해제된다. 실행/일시정지 후 30분 내 진행 신호가 없으면 권한을 회수하고 한 번 재추천 가능한 OPEN 상태로 돌린다. 두 번째 실행 중단 또는 전체 실행 기한 만료는 전액 환불한다. 웹의 이 샘플은 장시간 실행하지 않으며, 실제 AI heartbeat 연동은 후속이다.

## 서로 다른 컴퓨터·실제 GitHub 계정으로

서버 접근 권한 없이 공개 HTTPS 주소와 실제 GitHub 로그인으로 요청자·수행자를 나눠 시험하는 순서는 [사용 안내](USER_GUIDE.md)와 [TH-030 검증](verification/TH-030-cross-machine-cycle.md)(운영자 준비: 터널·OAuth App·TIG 자격)에 있다. 아래는 그 전 단계인 개발 서버 공유 방식이다.

## 두 PC를 같은 개발 서버에 연결

Git push는 코드를 공유한다. **서버 DB의 작업·잔액을 다른 PC의 DB로 동기화하지 않는다.** 각자가 `npm run dev`를 켜면 서로 다른 서비스를 테스트하게 된다.

지금은 유찬 서버 하나를 공유한다. 두 사람 모두 기존에 허용된 서버 SSH 접속 또는 VS Code Remote SSH를 사용해 **4173 포트**를 본인 PC의 4173으로 전달한다. VS Code Ports 탭에서 Forward a Port → 4173. Public visibility로 바꾸지 않는다.

```bash
# 본인 PC 터미널. 기존 서버 접근 권한이 필요하다.
ssh -N -L 4173:127.0.0.1:4173 <서버접속계정>@<서버주소>
```

그 상태에서 본인 PC의 브라우저와 CLI 모두 `http://localhost:4173`을 쓴다. 개발 로그인은 loopback 전용이며 외부 공개 인증이 아니다. `http://127.0.0.1:4173`이나 다른 로컬 포트는 현재 설정의 Origin과 달라 변경 요청이 거절되므로 주소를 그대로 맞춘다. 서버 접근 권한이 없는 외부 사용자를 위한 테스트는 실제 인증을 갖춘 스테이징 배포 단계에서 제공한다.

## CLI 설치

이 서버에는 `/home/imclab4/.local/bin/tig`로 설치했다. 다른 PC는 최신 구현 브랜치를 clone한 뒤 Node 24와 Git을 준비한다. 웹 개발에도 같은 의존성을 사용한다.

```bash
npm ci
npm run cli:install
tig --help
```

macOS/Linux/WSL에서는 본인 `~/.local/bin/tig`에 설치한다. 명령을 못 찾으면 `~/.local/bin/tig`를 직접 실행하거나 해당 폴더를 PATH에 추가한다. 기존의 다른 `tig` 프로그램은 덮어쓰지 않는다.

Windows 네이티브에서는 `npm run cli:pack` 후 다음을 실행한다. Windows의 실제 설치 검증은 아직 남아 있으며 WSL 경로를 우선 검증 대상으로 둔다.

```powershell
npm install --global .\.local\releases\tokenisgold-cli-0.5.0.tgz
tig --help
```

이 tarball은 로컬 배포용이며 npm 공개 레지스트리에 게시하지 않았다. Node 24가 필요하다. CLI만 설치하면 웹/DB를 별도로 켤 필요 없이 공유 서버에 연결할 수 있다.

```bash
tig connect --origin http://localhost:4173 --name "yuchan laptop"
# 출력된 링크를 본인 역할로 로그인한 웹에서 열고 코드 승인
# 륜호도 자기 PC에서 같은 명령을 실행하고 worker 계정으로 승인한다.
tig status
```

연결 토큰은 자기 PC의 TIG 상태 폴더에만 저장하며 Git에 넣지 않는다. 같은 PC에서 CLI도 두 역할로 시험하려면 각 터미널에 서로 다른 `TIG_STATE_DIR`를 설정한 뒤 각각 연결한다. macOS/Linux/WSL 예:

```bash
export TIG_STATE_DIR="$PWD/.local/requester-cli"
# 다른 터미널에는 .local/worker-cli 사용
```

## CLI와 웹을 섞어 시험하기

```bash
# 요청자 터미널: 작업 ID가 출력된다.
tig demo-post --reward 100

# 수행자 터미널: ID를 위 결과로 교체한다.
tig tasks
tig task <작업ID>
tig accept <작업ID> --yes
tig demo-run <작업ID> --yes

# 요청자: 웹에서 승인하거나 CLI로 승인한다.
tig task <작업ID>
tig approve <작업ID> --yes
# 문제 신고/종료를 선택할 때는 approve 대신 tig issue <작업ID> --yes
tig status
```

`demo-run`은 고정 JSON 예제 파일을 생성해 제출한다. 실제 AI 호출·GitHub PR 생성·사용자 프로젝트 수정은 하지 않는다. `tig submit <id> --file result.json`은 같은 fixture의 결과 파일/수행내역 JSON을 직접 제출할 때 쓴다. 입력 형식은 [거래 계약](contracts/lifecycle.md)을 따른다.

자연어 UX 예:

> 요청자: “Tokenisgold 로컬 테스트를 100 TIG로 올려줘.”
> 본인 AI: `tig demo-post --reward 100`을 실행하고 작업 ID를 알려준다.
> 수행자: “이 로컬 테스트 수락하고 샘플 결과 제출해줘.”
> 본인 AI: 작업을 읽고 `tig accept … --yes`, `tig demo-run … --yes`를 실행한다.

CLI 자체는 자연어 모델이 아니다. Codex/Claude Code에 `tig instructions`를 먼저 읽도록 지시한다. 일반 작업 인계 저장·게시 명령과 실제 실행 지원 여부를 혼동하지 않는다.

## 서버 재시작/검사

현재 서버의 로컬 PostgreSQL 실행 파일과 데이터는 `.local/postgres`에 보존되어 있다. 기존 개발 DB를 삭제하지 않는다. DB를 처음 만드는 다른 개발자는 [개발 안내](DEVELOPMENT.md)의 Docker 설정을 사용한다.

```bash
# TIG 루트, Node 24 환경
npm run db:migrate
npm run db:seed
bash scripts/dev-local.sh
```

`db:seed`는 최초 개발 잔액과 UI 샘플을 넣으며 반복 실행으로 TIG를 무한 추가하지 않는다. 기존 잔액을 초기화하는 명령이 아니다.

```bash
npm run build
npm test
npm run test:e2e
```

테스트는 TEST_DATABASE_URL 내 고유 임시 schema를 만들고 자기 schema만 정리한다. 웹 수동 테스트 DB를 초기화하지 않는다. 거래/설치의 검증 근거는 [TH-029 보고](verification/TH-029-transactions.md)에 기록한다.

## 새 기능: Inbox · Insights · 결과 다운로드 (0.2.0)

같은 개발 서버에서 기존 거래를 진행한 뒤:

1. 유찬은 **Inbox**를 연다. 수행자가 수락하거나 결과를 제출하면 알림이 들어오고 **Open task**로 검토 화면을 연다. 읽음 상태는 서버에 저장된다.
2. 결과의 **Download result**로 파일 내용·수행내역·검사 출처를 JSON으로 받는다. 다운로드만으로 원래 프로젝트가 수정되지는 않는다.
3. **Insights**에서는 본인의 최근 30일 요청 종류, 프로젝트별 요청, 직접 승인/자동 지급/환불과 TIG를 본다. 일반 지표는 매일 갱신되므로 당일 작업은 다음날 포함된다.
4. 지금 샘플 거래의 변화를 즉시 확인하려면 **Show live sample activity**를 켠다. 개발용 실시간 미리보기이며 실제 실적과 분리된다.

CLI도 같은 정보를 제공한다. 기존 설치를 갱신할 때 Node 24 환경에서 `npm run cli:install`을 실행한다. 이 서버의 설치본은 요청자 Git 게시를 포함한 0.5.0으로 갱신했다.

```bash
tig inbox
tig read <알림ID>
tig result <작업ID> --output result.json
tig insights
tig insights --sample
```

자연어 UX: “결과 제출 알림 온 것 열어보고 파일 받아줘” → 본인 AI가 `tig inbox`, `tig task`, `tig result`로 확인한다. “샘플 작업을 어떤 종류로 맡겼는지 보여줘” → `tig insights --sample`. 결과 적용/승인/지급은 다운로드와 별도 의사 표현이다.

이메일 전달은 아직 연결하지 않았다. Inbox와 일일 집계는 앱과 함께 실행되는 Worker가 필요하다. [새 기능 계약](contracts/inbox_insights.md)에 집계 기간·분모·접근 경계가 있다.
