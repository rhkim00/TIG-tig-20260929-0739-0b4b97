# TH-036 — main 통합 기록 (2026-09-10 UTC)

사용자 요청에 따라 PR #8 → #9 → #10을 merge commit 방식으로 main에 병합했다. 각 PR의 Application/Handoff/Workspace 검사 성공을 확인하고 source head를 지정해 병합했다. #9, #10의 base는 선행 병합 후 main으로 변경했다.

| PR | main 병합 SHA | 병합 시각 UTC |
|---|---|---|
| [#8](https://github.com/timeistoken/TaskHub/pull/8) | `fa316cf6e8e054b9df1afc46ebee14ea130b1741` | 15:09:00 |
| [#9](https://github.com/timeistoken/TaskHub/pull/9) | `cbd871d686966f2ba1e009bd285c6c35b8d62caf` | 15:09:27 |
| [#10](https://github.com/timeistoken/TaskHub/pull/10) | `856687ca6d51fc4ffaef62880759bbfa11bc8e52` | 15:09:34 |

각 단계의 `git merge-tree --write-tree origin/main <source head>`가 source tree와 정확히 일치했다. #10 병합 main과 테스트된 source `b48d7b37ef2b34e120001a273a4cfd32863c7376` 간 diff는 없다. [source Application 성공](https://github.com/timeistoken/TaskHub/actions/runs/34492934675). 후속 변경은 현재 협업 안내·작업 상태·새 인수인계 문서뿐이다. 후속 문서 PR과 최종 main의 CI는 [Actions](https://github.com/timeistoken/TaskHub/actions)에서 해당 SHA를 확인한다.

기존 branch/worktree, 개발 DB, TIG_test, 사용자가 게시한 요청/예치를 보존했다. 사람 간 상호 리뷰는 미기록이므로 기존 REVIEW 상태를 임의로 DONE으로 바꾸지 않았다. 일반 수행자의 격리 실행·필수 검사·마켓 제출·지급 연결 및 공개 베타 배포는 미완료다. 현재 기준과 다음 행동은 [NOW](../coordination/NOW.md)를 따른다.
