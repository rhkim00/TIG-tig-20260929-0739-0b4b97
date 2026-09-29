# TH-033 — 요청자 Git 게시 구현·검증 (2026-09-10)

[PR #8](https://github.com/timeistoken/TaskHub/pull/8), branch feat/TH-033-requester-git. 사용자가 수행자 실행보다 요청자의 자연어 명세·Git 게시를 먼저 구현하도록 승인했다. 제품 결정 P-067.

## 구현한 사용자 경험

- CLI 0.3.0 `init`: 본인 gh 인증을 사용한 공개 전달 저장소 연결/명시적 생성. Tokenisgold 기기 연결과 GitHub 인증 분리. 생성만으로 코드 업로드하지 않는다.
- 설치된 `tig instructions`에 기존 AI가 읽을 전체 명세 형식과 명령 절차 포함. 선택적으로 TOKENISGOLD.md와 기존 AGENTS.md/CLAUDE.md 참조 설치. 원래 지침 보존, 다른 파일/심볼릭 링크 덮어쓰기 거부.
- `request prepare/show`: 기존 AI가 작성한 구조화된 요청으로 request.md·request.json·선택 코드 스냅샷, 전체 파일/제외 preview·승인 digest 생성. 맥락·기완료 작업·범위·완료 조건·모델 요구·보상·기한 표시.
- `request publish`: 원본 작업 트리/인덱스/브랜치를 유지하고 원본 이력이 없는 별도 Git 요청 커밋을 push. 서버는 요청 문서/명세/코드/Git tree 일치를 검사한 후 기존 원장으로 게시·예치. 같은 ID 재시도와 로컬 단계 저장으로 중복 방지.
- 웹 작업 링크를 직접 열고 새로고침할 수 있다. 해당 작업에서 고정 커밋의 request.md·코드로 이동한다. 일반 요청에는 실제 AI 실행 미완료 문구 유지.

## 실행한 검증

| 검사 | 결과 |
|---|---|
| npm run build | TypeScript/Vite 통과 |
| npm run cli:install | tokenisgold-cli 0.3.0 생성·현재 서버 ~/.local/bin/tig 설치 |
| TIG_TEST_CLI=<설치본 경로> npm test | 44개 통과. 기존 API/정산/CLI 회귀 포함 |
| npm run test:e2e | desktop/mobile 6개 통과. 게시 링크 → 정확한 작업 → Git 링크 및 새로고침 포함 |
| Python workspace/workflow/contracts | 문서 링크, 33개 작업 DAG, 상태 계약 통과 |
| Python unit checks | team 7개, metadata probe 4개 통과 |
| git diff --check | 통과 |
| 실제 GitHub 읽기 | 현재 gh 계정으로 timeistoken/TaskHub 정보 조회 성공, public=false·push=true 확인. 생성·코드 공개 업로드는 수행하지 않음 |
| 개발 서버 | dev-local 재실행, 웹 localhost:4173 및 API health 200 |
| 화면 | requester-mobile screenshot 직접 확인. Git 문서 링크·보상·실행 미완료 안내가 화면에 표시됨 |

요청자 통합 테스트는 실제 임시 Git 프로젝트와 bare remote, 실제 git push, 설치된 CLI, HTTP API, PostgreSQL을 사용한다. GitHub CLI/API 경계만 명시적으로 대체한다. 입력 불충분/비밀값, 공개 생성 승인, 기존 AI 지침 보존·심볼릭 링크 거부, 승인 digest·계정 불일치, 원본 미커밋/인덱스 보존, 미선택 파일 제외, prepare 이후 변경 미전송, Git 검증 장애/파일 불일치 시 예치 없음, 재시도 성공, 응답 유실 뒤 idempotent 복구, 보상·명세 불일치 거부, 로컬 plan 변조 거부를 검사했다. GitHub client 자체는 parent history·truncated tree 거부를 별도 transport 테스트로 확인했다.

첫 GitHub CI의 마지막 모바일 새로고침에서 HTTP 429를 확인했다. 빠른 CI가 같은 서버/IP에 모든 시나리오를 연속 실행해 DB reset 뒤에도 분당 제한 카운터가 누적된 것이 원인이었다. 격리된 E2E 서버에서 reset마다 요청 제한 키를 분리하고 Git tree fixture도 초기화했다. 요청 IP는 그대로 두고 테스트에서만 생성자에 키 함수를 전달한다. 제품의 rate limit 수치/인증은 변경하지 않았다. 제한이 실제로 429를 반환하고 reset 후에만 새 시나리오에서 복구되는 회귀 검사도 추가했다. 수정 후 검증 결과는 후속 handoff와 최신 CI를 따른다.

초기 테스트 작성 중 기존 transfer 함수 호출 인자 오류를 수정한 뒤 전체 검사를 통과했다. 테스트마다 고유 DB schema를 사용하고 자기 schema만 제거하며 수동 개발 DB를 초기화하지 않았다.

## 검증하지 않은 범위와 제한

- 실제 외부 GitHub 공개 저장소 생성·push를 수행한 실증은 아직 없다. 사용자 프로젝트/개발 저장소를 임의로 공개하지 않았다. 실제 gh 읽기 성공과 로컬 원격 Git 테스트를 외부 게시 성공이라고 표시하지 않는다.
- 사람의 실제 Codex/Claude 대화에서 자동으로 명세를 작성한 것까지 E2E로 검증한 것은 아니다. TIG는 AI용 지침·명세 검사·게시 명령을 제공한다. 기존 AI가 해당 지침을 읽고 호출해야 하며 별도 AI inference API는 사용하지 않는다.
- 작은 텍스트 프로젝트 범위: 소스 98개+문서 2개, 파일 200 KB·전체 1 MB. 기존 보호 경로 규칙으로 hidden·binary·symlink 등을 제외하며 실행 권한은 복제하지 않는다. 제외 때문에 필요한 코드/설정이 부족하면 게시 전 해결해야 한다.
- Git과 DB는 원자적인 한 트랜잭션이 아니다. push 후 게시 실패 시 Git은 이미 공개됐을 수 있다. 같은 ID로 재시도하고 임의 삭제/새 게시로 숨기지 않는다.
- 실제 수행자 AI, 모델 지원/실행 증명, 추천·구독 증명, 결과 PR/Apply, 외부 OAuth·Windows/macOS 설치 검증·공개 배포는 후속이다.

## 인수인계

[요청자 사용법](../REQUESTER_QUICKSTART.md), [계약](../contracts/requester_git.md), [현재 작업](../coordination/NOW.md)을 따른다. PR 검사/병합은 GitHub 실제 상태로 확인한다. 유찬은 지정한 공개 테스트 저장소에서 기존 AI의 실제 자연어 게시를 확인한 뒤 수행자 흐름을 연결한다. 륜호는 TH-030 온보딩/웹 책임을 유지하며 테스트 거래 참여는 필수가 아니다.
