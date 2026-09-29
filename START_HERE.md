# Tokenisgold: clone 직후 여기부터

최종 결정자는 유찬(timeistoken), 웹/UI 담당은 륜호(rhkim00)다. AI 도구는 바뀌어도 이 절차를 따른다.

1. `AGENTS.md` → 이 문서 → [현재 할 일](docs/coordination/NOW.md) → [협업 절차](docs/COLLABORATION.md)를 읽는다.
2. 본인 clone에서 최초 한 번 실행한다. 유찬은 timeistoken, 륜호는 rhkim00을 사용한다.

```bash
python3 scripts/team.py setup --person rhkim00
python3 scripts/team.py sync --person rhkim00
```

3. sync가 보여주는 최근 `docs/handoffs/` 기록, 자신의 작업 문서, 관련 `docs/contracts/`를 읽는다. 제품 동작을 바꿀 때 `docs/product/00_confirmed.md`도 확인한다.
4. **작업 시작 전에 AI는 “누가 무엇을 바꿨는지 / 내 다음 작업 / 상대 다음 작업 / 선행 조건 / 충돌 여부”를 먼저 보고한다.** 미공유 변경/실제 리뷰·병합 여부를 추정하지 않는다.
5. 작업 종료/중단 때 코드와 인수인계 기록을 같은 커밋에 넣고 push한다. 로컬 commit만으로는 전달되지 않는다. 절차를 [협업 문서](docs/COLLABORATION.md)에서 따른다.

2026-09-10 PR #1~#10이 main에 병합됐다. 새 clone은 main에서 앱과 협업 도구를 바로 받는다. 기존 clone은 [최신 main 반영 안내](docs/coordination/NOW.md)를 따른다. 개발은 본인 작업 브랜치에서 진행하고 후속 PR의 base는 main으로 둔다.
Windows는 Python 3의 `python` 또는 `py -3`로 같은 스크립트를 실행한다. Git Bash hook에는 Python 3가 PATH에 있어야 한다.

AI 시작 문구:

> 나는 rhkim00(또는 timeistoken)이야. START_HERE.md와 AGENTS.md를 읽고 team sync를 실행해줘. 최신 인수인계에 따라 바뀐 점과 두 사람의 다음 일을 설명한 뒤, 내 배정 범위에서 진행해줘. 끝나면 코드·검사 결과·양쪽 다음 행동을 인수인계와 함께 commit/push하고 PR을 갱신해줘.
