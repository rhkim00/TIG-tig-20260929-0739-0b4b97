# 구독 활용·자동 실행·provider 약관 검토

확인일: 2026-09-09. 상태: 공개 공식 문서 검토 완료, Tokenisgold의 구체적 사업/실행 구조에 대한 허용 여부 미확인.
최종 제품 결정은 유찬이 한다. 공식 설명, 설계 해석, 추가 확인을 구분한다.
이 문서는 provider의 승인이나 법률 검토 완료를 의미하지 않는다.

## 이번 대화의 제품 방향

- 기존 구독과 공식 CLI 환경을 활용해 API 키 발급·추가 AI 서비스 가입·반복 로그인 부담을 줄인다(P-009).
- 현재 베타에서는 별도 과금되는 provider API 호출을 도입하지 않는다(P-009). Tokenisgold 서버/GitHub API 통신을 금지한다는 뜻이 아니다.
- 웹에서 사용자가 고른 작업을 수락하면 로컬 AI까지 시작하는 UX를 선호하되, 약관을 지키는 방식이어야 한다(P-010).
- UX 단순화가 계정 공유·token 추출·요청 중개·제한 우회를 허용하는 근거는 아니다.

## 공식 문서에서 확인한 사실

| 출처 | 확인한 범위 | Tokenisgold에 남는 문제 |
| --- | --- | --- |
| [OpenAI 인증 문서](https://learn.chatgpt.com/docs/auth) | Codex는 ChatGPT 구독 인증과 API key 인증을 구분한다. 로컬 로그인 재사용과 자동화 시 API key 사용 지침이 있다. | 구독 보유만으로 CLI 인증·실행 준비가 끝났다고 가정할 수 없다. |
| [Codex 비대화형 실행](https://learn.chatgpt.com/docs/non-interactive-mode) | codex exec와 저장 인증 재사용, 고급 ChatGPT 계정 기반 CI 방식이 문서화되어 있다. 해당 CI 방식에는 public/open-source repo 사용 금지 안내가 있다. | 로컬 실행과 CI 방식을 구분하고 공개 작업을 처리하는 구조에 적용되는 범위를 확인해야 한다. |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server) | 자체 제품 통합용 인터페이스, Codex가 관리하는 ChatGPT 로그인, 승인·진행 이벤트가 제공된다. | 이것만으로 타인의 작업과 TIG 정산을 결합한 시장까지 허용된다고 결론낼 수 없다. |
| [OpenAI 이용약관](https://openai.com/policies/terms-of-use/) | 계정 공유, 서비스 판매·배포, 자동 추출, 제한 우회 등에 제약이 있다. | 공식 자동화 기능의 범위와 Tokenisgold의 실제 서비스 제공 형태를 함께 검토해야 한다. |
| [Claude Code 인증](https://code.claude.com/docs/en/authentication) | 사용자가 공식 흐름으로 자기 구독에 로그인할 수 있다. API 인증 설정이 있으면 구독 대신 사용될 수 있다. | 설치·인증 방식 확인과 의도하지 않은 API 과금 방지가 필요하다. |
| [Claude Code 프로그램 실행](https://code.claude.com/docs/en/headless) | claude -p와 구조화된 결과를 받는 실행 방법이 문서화되어 있다. | 실행 기능의 존재가 제3자 사업 모델의 포괄적 허가는 아니다. |
| [Claude Code 법률·준수 안내](https://code.claude.com/docs/en/legal-and-compliance) | 제품에서 공식 binary를 실행하는 조건으로 Commercial Terms 동의, binary/인증 방식 보존, 사용자의 직접 인증·청구 등을 명시한다. 사용량의 대납·재판매·중개, 제3자의 Claude 로그인 제공과 구독 credential을 통한 요청 routing을 제한한다. 공식 binary에 사용자가 자기 구독으로 로그인하는 경우도 별도로 설명한다. | 로컬 공식 CLI 호출과 P2P 작업 중개가 이 조건에 부합하는지 별도 확인해야 한다. 단순히 “로컬이라 괜찮다”고 할 수 없다. |
| [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms) | 계정 공유·서비스 재판매를 제한하고 자동 접근은 API key 또는 명시적 허용을 조건으로 한다. | 공식 CLI 기능의 허용 범위와 Tokenisgold 거래 구조를 함께 확인해야 한다. |

문서는 변경될 수 있으므로 구현 방식 확정·출시 직전에 재확인한다. 플랜별 별도 계약이 있다면 적용 계약을 먼저 식별한다.

## 현재 설계 판단 — 공식 승인이 아닌 해석

기존 공식 CLI 환경을 활용하는 통합에는 기술적 근거가 있다. 모든 자동 실행을 일괄 금지라고 볼 근거도 부족하다.
그러나 Requester의 작업을 Worker의 consumer 구독으로 실행하고 TIG를 지급하는 구조가 서비스 사용량 중개/재판매인지,
사용자가 자신의 책임으로 수행하는 작업 결과의 교환인지 공개 문서만으로 확정할 수 없다.
현금이 아닌 TIG라는 점이나 로컬에 확인 버튼을 하나 추가하는 것만으로 이 문제를 해결했다고 보지 않는다.

구독 사용량 부족 시 유료 API로 자동 전환하지 않는다. 기존 사용자의 API 설정을 몰래 수정하거나 공식 CLI의 인증 기능을 제거하는 방식도 피한다.
구독 인증인지 확인할 수 없는 환경에서는 안내 후 Tokenisgold 실행을 시작하지 않는 방식을 설계 후보로 둔다.

## 간단한 UX 제안 — 세부 구현 미확정

1. 최초 한 번 Tokenisgold CLI 설치와 Tokenisgold 기기 연결.
2. 설치된 공식 AI 도구·인증 상태를 지원되는 인터페이스로 확인. credential 파일/token을 읽어 복제하지 않는다.
3. 준비되었으면 도구 재가입·반복 로그인 없이 작업 선택으로 이동. 미설치/인증 만료일 때만 공식 설치·로그인 안내.
4. 사용자가 웹에서 작업·사용 도구를 확인하고 Accept & Work 클릭.
5. 허용 범위가 확인된 경로로 CLI가 workspace/Task Package를 준비하고 공식 AI를 시작, 진행·결과를 웹에 동기화.
6. 사용자가 결과를 확인하고 Submit. Requester 승인과 정산은 별도 절차.

이 흐름은 목표 UX이며 provider 허용과 기기/작업 인증 조건을 충족하는 방식으로 확정해야 한다.
사용자가 클릭한 개별 작업의 시작과 유휴 quota를 서버가 자동 배정해 계속 소비하는 구조를 구분한다.
공식 CLI의 필수 권한 승인/안전장치를 없애서 클릭 수를 줄이지 않는다.

## 결정·추가 확인 항목

| ID | 상태 | 확인할 내용 |
| --- | --- | --- |
| POLICY-01 | 미확인 | OpenAI: 개인 구독 Codex로 제3자 coding task를 실행하고 TIG 보상을 받는 시장의 허용 범위 |
| POLICY-02 | 미확인 | Anthropic: 공식 CLI를 로컬에서 실행하는 Tokenisgold 통합과 TIG 교환이 제품 실행 조건·중개 제한에 부합하는가 |
| POLICY-03 | 미결정 | provider 문의/법률 검토를 맡을 사람과 확인 시점. 문의는 아직 보내지 않음 |
| POLICY-04 | 제안 | 공개 베타에서 자동 시작을 활성화하기 전 실행 구조·거래 구조의 근거를 확보하고 유찬이 결정 |
| POLICY-05 | 미결정 | 자동 시작이 허용되지 않거나 답이 불명확할 때 실행 UX·지원 범위·일정을 어떻게 조정할지. API 도입은 자동 대안이 아님 |

## 문의에 포함할 구조 — 발송하지 않은 초안

Tokenisgold는 별도 AI API 결제 없이 기존 구독을 가진 개인이 공식 unmodified CLI로 코딩 작업을 수행하는 시장을 계획한다.
Requester가 공개 repository의 작업을 게시하고 Worker가 직접 선택한다.
웹 버튼을 누르면 Worker 기기의 helper가 작업 환경과 prompt를 준비해 공식 CLI를 실행한다.
provider 인증과 token은 공식 CLI가 관리하고 Tokenisgold는 수집·복제하지 않는다.
검증·승인된 결과물에 대해 현금 구매/출금/직접 송금 없는 TIG를 지급한다.
이 구조와 웹 기반 로컬 시작이 허용되는지, 필요한 계약·제한·승인 절차가 있는지 확인하고 싶다.

## P-014~016 반영: 자연어 시작과 Task 추천

요청자는 기존 AI에서 자연어로 게시하고 수행자는 가용성을 알려 추천받은 작업에 Yes로 응답하는 흐름으로 구체화했다.
이를 반영해 provider 확인 시 작업 선택·동의·공식 CLI 실행·Git 결과물·TIG 보상 구조를 설명해야 한다.
Task 추천은 제품의 작업 배정 기능이며, 이 명칭만으로 구독 사용량 중개 여부가 해소되는 것은 아니다.
기존 허용 범위 미확인 상태를 유지한다. 자연어/Yes 동작만으로 약관 준수를 확정하지 않는다.

## 사용량·초안에 대한 추가 확인

P-018~020에서 선제 알림·자동 인계 초안·허용되는 보조 모델 활용을 요구했다.
[별도 공식 문서 검토](14_usage_and_drafts.md)에서 local metadata와 hook 지원을 확인했다.
이는 잔여 token 수의 정확한 공개나 소진 후 특정 모델 실행, 작업 시장 전체의 약관 허용을 보증하지 않는다.
한도 우회 없이 공식적으로 사용 가능한 모델만 사용하고, 별도 과금 API로 자동 전환하지 않는 원칙을 유지한다.

## 2026-09-10 요청자 명세 작성 adapter

[Codex non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)에서 `codex exec`, 저장 인증 재사용, schema 출력, ephemeral, ignore-user-config 옵션을 확인했다. [인증 문서](https://learn.chatgpt.com/docs/auth)는 ChatGPT 구독 인증과 API 키 과금을 구분하고 login status 및 forced_login_method를 제공한다. 로컬 설치 binary help에서도 해당 실행 옵션을 확인했다.

TH-034는 요청자 본인이 선택한 코드에서 명세를 작성하는 호출만 연결한다. TIG가 credential 저장소를 읽지 않고 공식 CLI에 인증을 맡긴다. API 키·라우팅 env를 전달하지 않고 ChatGPT 로그인 상태와 forced_login_method를 확인한다. AI 도구/후크/플러그인 사용을 제한하는 설정을 주고 별도 임시 작업 폴더와 선별 stdin을 사용한다. 실행 옵션 실패/미지원/인증 불일치를 무시하거나 API fallback하지 않는다. CLI 기본 작성 모델과 요청된 수행자 모델은 별개다.

이는 타인 작업을 보상받고 실행하는 시장 전체의 약관 확인이 아니다. Claude 자동 작성 adapter, 실제 구독 추론/출력·관리 설정 조합 검증은 남아 있다. 기존 POLICY-01/02 미확인 상태를 유지한다.
