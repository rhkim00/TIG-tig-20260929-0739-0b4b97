# TH-035 — 게시 확인·요청자 질문 축소·수행자 개인 체험

기준 2026-09-10, PR #10은 PR #9 위 후속이다. 현재 구현은 개인 체험이며 일반 마켓 수행/정산 완료를 뜻하지 않는다.

## 사용자가 게시한 실제 요청

- 웹 task `dc3f77e3-c3f6-40e1-a8ec-72c0ad631997`, 상태 OPEN, 400.00 TIG 예치. 조회 시 가용 2600.00 / 예치 400.00. 로컬 개발 계정의 잔액이다.
- [고정 공개 요청](https://github.com/timeistoken/TIG_test-tig-requests/blob/125021f6d9f4a328eccd6de5b709601e53cb8dba/request.md): Git blob 3개(request.md/request.json/code/solution.py), GitHub tree와 API 파일 내용의 Git blob SHA-1 일치 확인. 요청 package SHA-256/manifest도 로컬 검증.
- 실제 내용: shortest_path 함수/입출력 유지, heap 기반 Dijkstra 개선, 경로 복원·도달 불가·동률·0 가중치 등의 검증 요구. 요청 모델 astra / medium, 기한 2026-09-11T14:29:39.404Z. 분류 other. 게시 내용을 임의로 고치지 않았다.
- 사용자는 게시 성공을 확인했고 그 결과를 읽었다. 이번 세션이 게시/AI 수행 성공을 대신 만든 것은 아니다. 추가 터미널 전문은 전달되지 않아 정확한 질문 횟수/답변 순서/AI 작성 시간은 확인하지 못했다. 명세에 반복 요청/결정 위임이 기록되어 있음을 UX 근거로만 사용했다.

## 구현

CLI 0.5.0: 마지막 게시 질문 yes/details/later 및 한국어·기존 숫자 호환, 새 요청은 보조 명령 new로 시작. 누락 맥락 질문은 한 번에 묶고 결정 위임 때 추론 가능한 가정을 문서화하도록 지시한다. 본인 요청 `tig work`는 고정 패키지·요청 조건을 검사하고 공식 Codex의 가용 모델을 조회해 실제 호출 ID를 보여준다. 시작 동의 한 번 후 도구 실행을 제한한 JSON 코드 생성 → 경로/비밀/해시/크기 검사 → 별도 로컬 Git 원본·결과 커밋과 수행내역서 생성. 같은 결과 재열기 및 AI 결과 저장 이후 재시도는 추가 추론을 하지 않는다.

개인 체험은 서버 조회만 사용한다. claim/submit/settlement 호출과 외부 Git push는 없다. 사용자 원본 프로젝트와 기존 예치 상태를 보존한다. AI 보고·CLI 지정 모델·실행 증명·검사 출처를 구분하며 runtime not_run, providerVerified=false, paymentEligible=false를 명시한다.

## 검증

- TypeScript 컴파일, CLI 패키지/설치 0.5.0. 초기 테스트 helper 닫는 중괄호 누락 수정 후 통과.
- 설치본 CLI/work/wizard/requester 집중 검사 33개 통과. worker PTY에서 한글 네 한 번 → 실제 HTTP 조회·Codex model/list protocol fixture → 실제 로컬 Git 저장 → 재열기 때 AI 미호출 검증. 요청자 기존 게시·예치·재시도 회귀는 실제 PG/HTTP/Git 기반이며 AI/GitHub 경계 fixture 유지.
- 설치된 `tig work`를 실제 TIG_test 터미널에서 실행해 게시된 요청/400 TIG/gpt-6-astra medium/시작 질문까지 확인하고 아니요로 정상 중단. 생성 호출/원본 변경/게시/정산 없음.
- 실제 설치 Codex의 읽기 전용 model/list: astra 후보 gpt-6-astra 한 개와 medium 지원 확인. 사용자 package 읽기/검증 성공. 구독 추론 요청은 이번 검증에서 수행하지 않음.
- `tig doctor`: 격리 시작 불가/실행 비활성. 이전 namespace permission 오류와 동일 제약. 미검증 실행을 활성화하지 않음.

## 남은 조건

격리가 허용된 환경에서 합의된 코드·테스트 실행, CPU/메모리/네트워크 제한·실행 중단 검증이 먼저다. 실제 worker 수락/generation/heartbeat·검사 통과·Git PR·웹 결과·48시간 정산 연결이 남았다. provider 정책/모델 실행 증명도 미확인 상태다. 다른 OS와 실제 worker 구독 추론 품질은 이번 fixture 테스트로 인증하지 않는다. 개인정보/원문 수집 확대나 데이터 판매/외부 메시지 전송은 하지 않는다.

## CI 경로 수정

첫 CI run 34492676695는 앱/CLI 69개 중 68개 통과, 새 worker PTY 1개가 MODULE_NOT_FOUND로 실패했다. CI의 TIG_TEST_CLI는 상대 경로인데 PTY가 임시 프로젝트 폴더를 cwd로 써 다른 위치에서 해석했다. 테스트 시작 위치에서 resolve하도록 수정했다. 실제 패키지의 상대 경로를 사용한 work 테스트 8개를 로컬 재실행해 통과했고 제품 코드는 바뀌지 않았다.
