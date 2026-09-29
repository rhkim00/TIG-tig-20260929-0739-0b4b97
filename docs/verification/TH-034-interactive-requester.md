# TH-034 검증 — 대화형 요청자 CLI

2026-09-10, feat/TH-034-interactive-requester, [PR9](https://github.com/timeistoken/TaskHub/pull/9), PR8 위 후속. CLI 0.4.0.

## 구현

기본 tig 대화형 진입, 설정 기억/재연결, 공식 gh 로그인, 공개 전달 저장소 연결/생성 확인, 자체 Codex 명세 작성, 추가 질문/누락 거래 조건, 선택 파일/보호 제외, 코드 변경 감지, 고정 Git snapshot, 공개·TIG 리뷰, yes 게시, 저장 후 재실행/동일 요청 재시도. 영문 색상·진행 표시, 비TTY 안내, terminal control sequence 제거, Ctrl+C·AI 프로세스 timeout 정리. AI provider 계정 파일을 TIG가 읽지 않고 API 키 환경변수를 전달하지 않는다.

## 실제 검증 범위

- Node24 TypeScript/Vite build와 설치 패키지. 초기 test fixture 타입 오류를 수정했다.
- 전체 앱·설치 CLI 테스트 50개 통과 (추가 최초 Git baseline 테스트 및 최종 소규모 UI 변경 재검증은 아래 최종 결과에 기록). PostgreSQL 격리 schema와 실제 HTTP 사용.
- 실제 PTY에서 설치 CLI를 시작하고 자연어 입력, 로컬 Codex executable fixture 호출, 명세 생성 후 저장/종료, 다음 실행에서 명세 읽기/게시, 취소 확인. 두 번째 실행은 추가 AI 호출 없음. 실제 로컬 Git commit/push→bare remote, 서버 Git tree 검증→TIG 예치/웹 링크 반환. 기존 사용자 source HEAD/index 보존.
- AI adapter: 구독 인증/구버전 차단, schema·비밀 검증, stdin 선별 코드, API 키/라우팅/Node preload env 미전달, 임시 출력 삭제, timeout/취소/오류 진단 비노출. 요청된 모델/추론 그대로 유지, 조건이 있는 요청에 추가 폼 입력 없음.
- 공유 선택 번호/range, secret 제외, 작성 도중 파일 변경 시 게시 준비 차단. 공개 중간 실패 재시도는 같은 ID/digest를 사용하며 사용자에게 내부 digest를 요구하지 않는다.

## 제한

AI 출력은 fixture다. 실제 Codex 구독 추론·품질·정책/관리 설정 조합을 실행 검증하지 않았다. GitHub는 로컬 transport로 대체했으며 실제 공개 코드 업로드/저장소 생성은 실행하지 않았다. 실제 CLI help와 공식 문서에서 옵션을 확인한 것과 실제 추론 완료를 구분한다. Claude 자동 작성/실제 수행자 runner/공개 서비스 배포는 미구현 후속이다. Linux PTY에서 검증했고 Windows/macOS 네이티브는 미검증이다. 대형 repo에는 현재 98파일/자동 작성 약160KB 한계가 있어 파일 선택이 필요하다.

[실제 사용법](../REQUESTER_QUICKSTART.md), [기반 Git 계약](../contracts/requester_git.md).

## 최종 로컬 확인

전체 50개 통과 후 추가 최초 Git baseline 검사를 포함해 요청자/대화형 관련 17개를 재실행해 통과했다. 설치 CLI의 실제 PTY에서 공식 로그인 대신 사용한 gh fixture가 stdin을 독점하고 이후 TIG 질문으로 복귀하는 것을 확인했다. `yes` 게시, 초기 빈 commit에 staged 파일 미포함, 추가 AI 없이 재실행 게시, 취소와 파일/폴더 선택 검증 포함. 이후 TypeScript 재검사 통과. 데스크톱/모바일 E2E 6개 통과. 문서·34작업 DAG·정적 계약·whitespace 통과. Python 검사는 최초 잘못된 tests 경로에서 0개로 종료해 통과로 세지 않았고, 실제 scripts 경로에서 다시 실행했다.

현재 설치본 시작 화면을 PTY에서 직접 확인하고 첫 질문에서 Ctrl+C로 종료했다. 이 확인은 명세 작성/게시를 실행하지 않았다. 로컬 웹4173/API4310 health 모두 HTTP200. 실제 외부 AI 추론·공개 게시 제한은 위와 동일하다. 원격 최종 CI는 PR 체크를 기준으로 확인한다.

## 0.4.1 실사용 피드백 회귀

TIG_test 프로젝트 연결 및 solve this session을 내용 전문/credential 없이 확인했다. 사용자 요청은 저장되었지만 candidate/pending은 없었다. 보상 질문이 AI 이후여서 미입력 상태로 다음 단계로 진행한 것이며, 이 관찰에서 게시/예치 완료라고 추정하지 않았다.

보상은 현재 사용자 문장에서 읽거나 AI 호출 전에 별도로 받는다. AI의 9999 TIG 응답을 사용자의 100 티그보다 우선할 수 없다. 누락/0/음수/모호한 금액은 진행하지 않으며 새 session 보상을 저장한다. 한국어 설명/답변을 그대로 AI에 전달하고 메뉴 네/아니요/코덱스/클로드 코드 등은 로컬 파서로 처리한다. 게시 메뉴의 아니요는 저장/종료이며 승인이 아니다.

설치 CLI PTY에서 solve this → 100 티그 → 새 파일 포함 네 → Codex 사용 네 → 저장 → 같은 폴더 재실행 시 폴더 질문 생략 → 네 게시를 검증한다. 실제 Git/HTTP/DB를 쓰며 AI/GitHub 경계는 fixture다. 보호된 .env는 새 파일 전체 포함에 네로 답해도 제외한다. 기본 최초 연결에서 주소 입력을 요구하지 않고, 대상 서버 변경 시 기존 token을 재사용하기 전에 재연결하는 검사를 추가했다.

TIG_RELEASE_ORIGIN을 테스트 주소로 설정해 실제 tarball 내부의 내장 주소를 확인했으며 테스트 주소로 연결하지 않았다. 이후 개발 기본값으로 다시 패키징/설치했고 설치본이 localhost:4173인지 확인했다. TypeScript 및 문서·DAG·whitespace 검사를 통과했다. 이번 검증에서 사용자 TIG_test 파일/기존 session을 삭제하거나 실제 AI 추론/외부 공개 게시를 실행하지 않았다. 최종 원격 검사는 PR9의 현재 head 체크를 따른다.

## 0.4.2 — VS Code Codex discovery (2026-09-10)

TIG_test 사용자가 새 파일 포함 후 Codex 미설치 안내를 받았다. 호스트에는 공식 OpenAI VS Code Remote 확장에 Codex가 있었지만 일반 터미널 PATH 탐색만으로는 발견하지 못했다. PATH/local bin 우선 탐색 뒤 기본 VS Code/Remote/Insiders 설치에서 실행 가능한 현재 OS·CPU 바이너리를 찾도록 수정했다. 확장 package metadata와 obsolete 목록을 확인하며 숫자 버전 내림차순으로 선택한다. 내부 확장 경로는 고정 공식 API가 아니므로 기존 CLI 기능/ChatGPT 로그인 readiness 검사를 유지한다.

- `npm run cli:install`: TypeScript 컴파일, 0.4.2 패키지/관리 launcher 설치 성공. 처음 추가한 테스트 helper의 TestContext 타입 오류는 명시 타입 import로 수정 후 빌드 통과.
- 설치된 local-ai 모듈에서 PATH를 `/usr/local/bin:/usr/bin:/bin`으로 제한: 실제 Remote 확장 Codex 자동 탐지, 필요한 CLI flags 및 ChatGPT 로그인 검사 통과. 추론 요청/공개 게시 없음.
- 설치 CLI 대상 executables/wizard/requester 테스트 27개 통과. 독립 설치 우선, 최신 숫자 버전, 누락/obsolete/다른 CPU/손상 metadata/실행 권한, 실제 PTY의 한국어 응답·저장·재시도·게시 회귀 포함. AI 응답/GitHub는 fixture, HTTP/DB/Git는 로컬 실물.
- 사용자 TIG_test 코드·저장 세션은 수정하지 않았다. 실제 구독 AI 명세 작성 및 외부 GitHub 공개 게시, macOS/Windows 실증은 미수행.
