# Tokenisgold 개발 버전 실행

최신 서버/CLI/웹 통합은 `main`에 포함돼 있다([병합된 PR #6](https://github.com/timeistoken/TaskHub/pull/6)). 륜호 기존 브랜치를 쓸 때 NOW의 최신 코드 반영 안내를 따른다.
바로 써보려면 [두 사람 테스트 안내](TRY_TOGETHER.md), 현재 범위/남은 검증은 [TH-031 보고서](verification/TH-031-inbox-insights.md)를 따른다. 아래 Day 1~4 설명 위에 거래 구현이 추가되었다.

## 새 컴퓨터

Node 24(.nvmrc), npm, Git, Docker Compose를 준비한다. 설치된 Node 18은 지원하지 않는다.

```bash
git fetch origin
git switch main
git pull --ff-only origin main
npm ci
cp .env.example .env
docker compose -f infra/dev/compose.yml up -d
npm run db:migrate
npm run db:seed
npm run dev
```

웹은 http://localhost:4173, API는 http://127.0.0.1:4310. 브라우저에서는 웹 주소만 연다.
`Explore local preview`로 들어가고 `Switch preview account`로 다른 샘플 계정을 볼 수 있다.
seed는 로컬용 계정 두 개·각 3,000 TIG 발행·마켓 예시 세 개를 만든다. 수행자 예치 이후 가용 잔액은 줄어든다. 반복 실행해도 샘플 발행을 중복하지 않는다.
이 예시 저장소는 게시 검증을 통과하는 실제 저장소가 아니다. 새 작업을 게시하려면 Connections에서 실제 공개 저장소를 연결한다.
미구현 수락/AI 실행/결과 정산을 완료된 것처럼 보여주지 않는다.

## 지금 이 서버

```bash
cd /mnt/imclab_data2/yccho/TIG
bash scripts/dev-local.sh
```

이 worktree `.local/runtime`에 Node 24가 있고 `.local/postgres`에 별도 PostgreSQL 16이 있다. 둘 다 Git 추적 제외다. 시스템 설치/전역 Git 신원은 변경하지 않았다.
`.env`는 이 개발 DB를 가리킨다. PostgreSQL은 loopback 55432, 개발 데이터만 저장하며 외부 서비스 주소가 아니다.
원격 VS Code라면 Ports에서 4173을 본인 컴퓨터로 포워딩하고 http://localhost:4173을 연다. 공개 포트로 공유하지 않는다.

## CLI와 기존 AI

아래 명령은 저장소 루트에서 실행한다. 다른 프로젝트 경로는 절대경로로 지정한다.

```bash
npm run tig -- instructions
npm run tig -- connect --origin http://localhost:4173
npm run tig -- project --repository OWNER/REPO --type web_app --stack TypeScript,React
npm run tig -- checkpoint --project /absolute/project --summary "What is done, what is next, and how to verify it."
npm run tig -- untracked --project /absolute/project
npm run tig -- checkpoint --project /absolute/project --include src/new-file.ts
npm run tig -- watch --project /absolute/project
```

`connect`는 터미널에 나온 링크/코드를 웹에서 확인하면 완료된다. 기기 토큰은 provider credential이 아니라 Tokenisgold 접근용이며 사용자 로컬 상태 폴더에 0600으로 보관한다. Windows ACL/키체인 지원 검증은 후속이다.
기존 AI가 자연어 의도를 해석하고 `instructions`의 계약에 따라 명세 JSON을 작성한다. 추가 provider inference API를 부르지 않는다.
`watch`는 해당 터미널에서 실행 중일 때 파일 변경을 자동 저장한다. OS 로그인 시 자동 시작/두 AI의 응답 hook 자동 설치는 아직 제공하지 않는다.

게시 파일 예시(실제 프로젝트 ID와 모델/추론은 본인 요구/조회에 맞춰 작성):

```json
{
  "projectId": "00000000-0000-4000-8000-000000000000",
  "title": "Add a keyboard shortcut to search",
  "requestCategory": "feature",
  "scope": "Add a search shortcut and preserve the existing navigation.",
  "acceptanceChecks": ["The shortcut opens and closes search using the keyboard"],
  "aiRequirement": {"provider": "codex", "model": "REQUESTED_MODEL", "effort": "REQUESTED_EFFORT", "source": "declared"},
  "rewardTig": "1000",
  "executionDeadlineAt": "2099-01-01T00:00:00Z",
  "commandApproval": {"kind": "explicit_post", "text": "Post this task for 1,000 TIG"}
}
```

시각은 형식 설명용이다. 실제 명령에서는 요청자가 정한 완료 기한을 사용한다. baseCommit/인계서 ID/hash는 CLI가 저장 초안에서 채운다.

```bash
npm run tig -- post --project /absolute/project --spec /absolute/task.json
npm run tig -- tasks --mine
npm run tig -- status
npm run tig -- export --project /absolute/project --output /absolute/handoff.json
npm run tig -- sync-codex
npm run tig -- sync-claude
npm run tig -- claude-statusline install
npm run tig -- claude-notes install
npm run tig -- doctor
```

`tig`는 묻지 않고 판단한다: 프로젝트는 지금 폴더(Git)→최신 로컬 AI 세션이 편집한 저장소→마지막 tig 프로젝트, 근거는 커밋·변경·세션 기록(마지막 요청·답변·한도·편집 파일), 초안 도구는 한도에 걸린 쪽을 빼고 세션 도구 우선, 수행자 AI와 예상 TIG(카테고리·파일 수 규칙, 잔액 상한)는 요약에 채운다. 사용자는 요약 화면에서 `yes`/`details`/`later` 또는 금액·`provider / model / effort`로 답한다. 직접 설명은 `tig "설명"`, 근거가 전혀 없을 때만 설명을 묻는다.

export는 로컬 파일만 만든다. 웹 Post a task에서 인계서를 가져올 수도 있다. 명세가 부족하면 파일 업로드 전에 거부한다.
사용량 `sync-codex`는 공식 도구가 PATH에 있고 본인의 기존 ChatGPT 로그인이 있을 때 동작한다. `sync-claude`는 `claude-statusline install`로 등록한 Claude Code 상태줄이 받아 둔 5시간/7일 사용률만 보낸다. 원문 이메일/credential은 저장/전송하지 않는다. 자동 TIG 지급 자격 증명과는 다르다.
`doctor`는 Node·Git·GitHub CLI·Codex/Claude Code 로그인·Tokenisgold 연결을 표로 보여주고 ✗ 항목마다 고칠 명령을 붙인다. 사용자 순서는 [사용 안내](USER_GUIDE.md).

## 실제 GitHub 로그인

GitHub OAuth App을 등록하고 `.env`의 `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`을 로컬에서 설정한다. secret을 AI 대화/PR에 붙여넣지 않는다.
Homepage URL `http://localhost:4173`, callback `http://localhost:4173/auth/github/callback`. 웹과 callback의 host를 정확히 일치시킨다.
서버는 read:user로 로그인 신원만 조회한다. 이 단계에서 저장소 쓰기 권한이나 AI 계정 토큰을 받지 않는다. PR 제출/Apply 권한은 후속 범위다.
2026-09-13에 공개 HTTPS 주소(cloudflared quick tunnel)와 실제 OAuth App으로 브라우저 로그인·기기 연결·다른 컴퓨터의 수행까지 검증했다. 절차와 한계는 [TH-030 검증](verification/TH-030-cross-machine-cycle.md)에 있다. 외부 주소를 쓰면 Homepage/callback을 그 주소로 등록하고 `APP_ORIGIN`을 같게 둔다.

## 검사

```bash
npm run build
npm test
npx playwright install chromium
npm run test:e2e
python3 scripts/check_workspace.py
python3 scripts/check_workflow.py
python3 scripts/check_contracts.py
python3 -m unittest discover -s scripts/probes -p 'test_*.py'
git diff --check
```

테스트 DB 주소 TEST_DATABASE_URL이 없으면 테스트를 생략하지 않고 실패한다. 테스트별 임시 schema를 만들어 종료 시 그 schema만 제거한다.
브라우저 테스트는 실제 HTTP/PostgreSQL/Chromium과 명시적인 GitHub 테스트 transport를 사용한다. `.local/screenshots`에 UI 확인 이미지를 남긴다.
빌드된 서버만 실행하려면 `npm run build` 후 APP_ORIGIN을 해당 주소로 설정하고 `npm start`를 사용한다. 운영 배포/로그/관측/자격 검증/격리 완료를 대신하지 않는다.
