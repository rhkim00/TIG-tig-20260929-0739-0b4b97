# TH-032 — main 병합 기록 (2026-09-10 UTC)

사용자의 “main병합도 도와줘” 지시로 PR #1~#6을 순서대로 main에 병합했다. 각 source head의 CI 성공을 확인하고 merge commit 방식으로 이력을 보존했다. Draft #2는 검증 문서로 ready 전환 후 병합했다. 사람 간 GitHub 리뷰는 기록되지 않았으며, 미해결 기술 검증은 계속 미해결이다.

| PR | main 병합 커밋 | 병합 시각 |
|---|---|---|
| [#1](https://github.com/timeistoken/TaskHub/pull/1) | `62484ebbad1070a82a712a322b636ade7d682740` | 2026-09-10T05:04:53Z |
| [#2](https://github.com/timeistoken/TaskHub/pull/2) | `5a0b4da28452ab2eeca6c447f57705bc0dddfbe8` | 2026-09-10T05:05:01Z |
| [#3](https://github.com/timeistoken/TaskHub/pull/3) | `b939218a75f7f9d5667ea2be701b6bf00d24c3e9` | 2026-09-10T05:05:08Z |
| [#4](https://github.com/timeistoken/TaskHub/pull/4) | `f5060b8f7e54c8595e079a42e536a3d4e2261ec0` | 2026-09-10T05:05:16Z |
| [#5](https://github.com/timeistoken/TaskHub/pull/5) | `9e3da6c41f0cd24637c3da21a6cb0897d0f99a09` | 2026-09-10T05:05:23Z |
| [#6](https://github.com/timeistoken/TaskHub/pull/6) | `1fccb0812d4d769f949e4c4ffb7e8bc001561dcd` | 2026-09-10T05:05:32Z |

각 단계에서 `git merge-tree --write-tree origin/main <PR head>` 결과가 해당 PR의 tree와 정확히 같음을 확인했다. #6 병합 후 main tree는 검증된 `76ca5222abf8e280f905cc0bc7e0eb9fab39b960`의 tree와 동일했다. 강제 push·source branch 삭제·다른 worktree 전환 없이 통합했다.

## 검증 범위

- PR #1~#6 각 head의 등록된 CI가 성공한 것을 GitHub에서 확인했다.
- 최신 앱의 구현 검증은 [TH-031 보고서](TH-031-inbox-insights.md): 서버/설치 CLI 34개와 desktop/mobile E2E 4개, build.
- 이번 후속 변경은 협업 문서만 수정한다. main push는 Application checks / Workspace checks, 후속 문서 PR은 여기에 Handoff checks까지 실행한다. 최종 상태는 [GitHub Actions](https://github.com/timeistoken/TaskHub/actions)에서 해당 head SHA로 확인한다. 실행 중인 검사를 통과로 간주하지 않는다.
- #6 병합 main `1fccb0812d4d769f949e4c4ffb7e8bc001561dcd`의 [Application checks](https://github.com/timeistoken/TaskHub/actions/runs/34439689358)와 Workspace checks 성공을 확인했다.
- 과거 보고서·append-only handoff의 당시 미병합 기록은 보존했다. 현재 상태는 이 보고서·NOW와 GitHub PR 실제 상태가 기준이다.

## 다음 기준

새 clone은 main에서 시작한다. 개발은 본인 작업 브랜치, 후속 PR base는 main이다. 기존 TH-030에 자체 변경이 없으면 `git fetch origin` 후 `git merge --ff-only origin/main`으로 업데이트한다. 분기/미커밋 변경이 있으면 AI가 비교하여 보존·통합한다.

TH-001 BLOCKED 및 기존 REVIEW는 상호 리뷰/남은 검증 상태를 나타낸다. 실제 AI runner, 신뢰할 수 있는 구독 확인, 외부 OAuth와 공개 베타 배포는 완료되지 않았다. [현재 보드](../coordination/NOW.md)의 다음 작업을 따른다.
