# TH-035 개인 수행자 체험 계약

`apps/cli/src/work.ts`, `worker-code.ts`, `models.ts`. 기존 서버 lifecycle API는 변경하지 않는다. 거래 수락/generation/heartbeat/submit는 [기존 계약](lifecycle.md)의 guard를 유지한다.

- 입력은 연결 계정 본인의 Git 게시 요청. task URL은 고정 GitHub commit이어야 하며 artifact의 파일 hash/manifest와 request.json→request.md 렌더링 및 공개 조건이 일치해야 한다. 전체 repo clone 대신 API의 이미 검증된 공개 snapshot을 읽는다.
- 개인 체험 key는 origin/user/task/manifest 해시. 동시에 하나만 실행하며 취소 시 잠금을 해제한다. SIGKILL 등 비정상 종료의 stale lock은 명시적으로 복구한다.
- Codex 공식 account/read 및 model/list만 읽고 계정 원문/credential을 기록·전송하지 않는다. metadata helper는 허용된 read method만 제공하며 API key 환경은 제외한다. 모델 catalog는 client observation이며 실행 증명이 아니다. 별칭은 후보를 보여주고 시작 동의에 정확한 ID를 포함한다.
- 생성기는 code/ 상대 경로의 전체 파일 내용 변경 목록, 삭제 목록, 요약, 제안 테스트, 한계를 JSON으로 출력한다. 실행 도구/사용자 규칙/MCP를 제한한 read-only 모드이며 외부 프로젝트 명령을 수행하지 않는다. 크기 180KB 입력/500KB 결과/98개 코드 파일, 보호 경로·중복·case 충돌·file/directory 충돌·secret·hash 검사.
- 결과의 단일 공개 전환은 로컬 임시 Git 폴더→result rename이며 receipt와 함께 보인다. candidate가 저장된 뒤 재시도는 AI를 다시 부르지 않는다. 원본 Git index/작업 트리 및 공개 repo에 쓰지 않는다.
- report.md와 result.json은 AI가 말한 변경 설명과 TIG의 실제 검증 출처를 분리한다. runtime=not_run, providerVerified=false, submitted=false, paymentEligible=false를 고정. local elapsedMs는 작업 난이도나 실제 전체 수행 시간의 증명이 아니다.
- API 조회만 수행하며 자기 거래 예치 이동·마켓 제출·48시간 검토 시계 시작·GitHub push/PR은 없다. 개인 체험 결과에 48시간 자동 지급을 적용하지 않는다. 게시된 원래 작업의 기한은 계속 흐른다.

소비자 륜호: 결과 폴더 안내/개인 체험 문구를 웹 온보딩에 반영할 수 있다. 일반 수행자 실행 준비로 표시하지 않는다.
