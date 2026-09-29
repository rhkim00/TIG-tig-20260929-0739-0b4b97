# TH-001 기술 검증 1차 결과

검증 기준일 2026-09-09. 정책 기준 `39517f3`, 검증 브랜치 `docs/TH-001-feasibility`, [Draft PR #2](https://github.com/timeistoken/TaskHub/pull/2).
실제 수행 범위는 현재 Linux 머신의 설치 상태·공식 Codex metadata·통제된 bubblewrap 시작 실험이다. 제품 전체 실행/다른 OS/외부 코드/유료 추론 검증이 아니다.

## 결과

| 대상 | 근거 | 결과/한계 |
| --- | --- | --- |
| Codex 설치 | `codex --version` | `codex-cli 0.153.4`, VS Code extension bundled CLI. 일반 npm/native 배포본과 동일 지원이라고 가정하지 않음 |
| protocol export | 공식 `generate-json-schema`를 임시 디렉터리에 출력 | 304개 schema, account/read·rateLimits/read·usage/read·model/list 포함. protocol 존재는 모든 endpoint의 실조회 성공과 다름 |
| account/read | 공식 stdio initialize→initialized→account/read(refreshToken=false) | 성공. ChatGPT 계정과 planType 문자열 존재 확인. 플랜값/이메일/id/credential은 출력·파일에 남기지 않음 |
| rateLimits/read | 같은 공식 연결에서 read 호출 | 성공. 2개 bucket, 3개 window에 사용률·window 길이·reset 필드 존재. 실제 수치·식별자는 저장하지 않음 |
| Claude CLI | PATH의 executable 탐색 | 없음. 직접 설치·인증·실행하지 않았으며 plan 세부 등급 실조회 미검증 |
| 런타임 | 버전 명령 | Node v18.19.1, npm 9.2.0, Linux 6.8.0-137-generic, bubblewrap 0.9.0 |
| Docker/PostgreSQL | PATH executable 탐색 | 현재 PATH에서 발견되지 않음. 서버 설치 자체의 전면 검색 결과는 아님 |
| Linux 격리 smoke | 임시 fixture만 mount, namespace 격리·루프백/메모리 제한 실험 시도 | 시작 단계 exit 1, namespace permission denied. 내부 검사 미실행. 시스템 보안 설정을 완화하지 않음 |
| 계정 metadata 출력 보호 | projection의 secret/identity canary 테스트 4개 | 통과. 임의 전체 응답/오류 메시지는 저장하지 않음. 전체 보안 감사는 아님 |
| 상태 계약 | 8개 상태·19개 전이의 reachability/terminal/정산/claim guard 구조 검사 | 통과. DB transaction·시간 경합·실제 guard 구현은 미검증 |

## 재현 명령

```bash
python3 scripts/probes/codex_metadata.py
python3 scripts/probes/codex_metadata.py --account
python3 scripts/probes/linux_sandbox.py
python3 -m unittest discover -s scripts/probes -p 'test_*.py'
python3 scripts/check_contracts.py
python3 scripts/check_workspace.py
git diff --check
```

첫 명령은 설치 binary의 schema export만 수행한다. `--account`는 기존 공식 인증으로 읽기 전용 계정/한도 조회를 한다. 모델 생성, thread 조회, login/logout, credential 파일 읽기를 코드에 넣지 않았다. 계정 원문·provider 에러 원문·server stderr는 출력하지 않는다.
Linux smoke는 합성 파일과 로컬 loopback만 사용하며 외부 네트워크/타인 코드/사용자 프로젝트를 사용하지 않는다. 준비 실패를 통과로 보고하지 않지만 환경 진단 도구이므로 프로세스 exit 0과 JSON status를 구분한다.

## 공식 자료와 해석

- [OpenAI App Server](https://learn.chatgpt.com/docs/app-server): stdio handshake와 계정/한도 protocol. 이번 설치본에서 해당 read 2개만 실검증했다. 세부 플랜 enum은 반환 가능 이름이지 표준 가격과 검증된 매핑표가 아니다.
- [OpenAI 인증](https://learn.chatgpt.com/docs/auth): 구독 인증과 API 인증, 자동화 권고를 구분한다. metadata 성공은 P2P TIG 작업 시장 허용을 뜻하지 않는다.
- [Claude CLI](https://code.claude.com/docs/en/cli-usage): auth status JSON 경로가 문서화돼 있다. 이 환경에서 반환 schema/플랜 값은 확인하지 못했다.
- [Claude 제품 통합 조건](https://code.claude.com/docs/en/legal-and-compliance): 공식 binary·직접 인증/청구 등 조건과 usage 중개/credential 수집 제한을 함께 검토해야 한다. 공식 CLI 구독 로그인 가능성만으로 Tokenisgold 구조의 허용을 단정하지 않는다. 해당 사업 구조에 대한 답변을 받은 것은 아니다.
- [Claude sandbox 문서](https://code.claude.com/docs/en/sandboxing): sandbox의 범위/네트워크 등 제한을 설명한다. 기본 Bash sandbox만으로 우리 전체 로컬 보호 요구가 검증됐다고 표시하지 않는다.

검색 snippet과 실제 열린 문서가 달랐던 정보는 열린 공식 본문을 기준으로 기록했다. provider 문의는 보내지 않았다.

## 구현에 반영한 결론

1. Codex의 공식 read 경로로 플랜/한도 존재 여부를 확인하는 경로는 이 환경에서 동작한다. 실제 플랜 가격 매핑·지급 자격 증명·중복 계정 방지는 별도다.
2. 클라이언트가 metadata를 바꿔 서버로 보낼 수 있으므로 해당 조회 자체를 server-verified 결제로 표시하지 않는다. 증명 경로가 없으면 고액 지급을 검증 완료로 출시할 근거가 없다.
3. 현재 서버에서는 bubblewrap 강제 격리 시작부터 막힌다. namespace가 허용된 테스트 환경 또는 승인된 다른 격리 경로에서 검증해야 한다. 현재 머신을 공개 베타 Worker로 인증하지 않는다.
4. Claude와 macOS/Windows/WSL2는 미검증이다. 지원 도구/OS 목표와 실제 통과 목록을 분리한다.
5. 검토용 [API/원장/데이터 계약](../contracts/README.md)을 작성했다. 실제 DB·서버 구현과 검증 완료는 아니다.

## 다음 실행 작업

- TH-001: 사용 가능한 격리 테스트 환경과 Claude 설치/인증 경로 확보, OS 지원표·resource budget·버전/호스팅 견적 검증. provider 허용 확인은 별도 근거 작업.
- TH-002 담당자: 승인된 영어 UX와 오류/복구 화면을 이 계약의 상태/오류에 맞춰 제안. 미업로드 진행은 추정하지 않음.
- TH-003: TH-001/002 근거를 반영해 API 필드·원장·삭제 정책을 최종 계약으로 검토하고 실제 DB 경합 테스트 작성.

이번 세션에서는 파트너에게 메시지를 보내거나 실제 provider 문의, 유료 도구 설치/인프라 구매, PR 병합, 제품 배포를 하지 않았다.
