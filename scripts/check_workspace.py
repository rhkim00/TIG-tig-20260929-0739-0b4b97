"""Validate the initial collaboration workspace without third-party packages."""
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[1]
required = ["README.md", "AGENTS.md", "Tokenisgold_service_plan.txt",
            "docs/COLLABORATION.md", "docs/DECISIONS.md",
            "docs/coordination/BOARD.md", "docs/coordination/TASK_TEMPLATE.md"]
errors = [f"Missing: {name}" for name in required if not (root / name).is_file()]
for path in sorted((root / "docs/coordination/tasks").glob("TH-*.md")):
    content = path.read_text(encoding="utf-8")
    for field in ["상태", "담당자", "리뷰어", "선행 작업", "브랜치/PR"]:
        if f"- {field}: " not in content:
            errors.append(f"{path.name}: missing {field}")
    if not re.search(r"^- 상태: (TODO|IN_PROGRESS|REVIEW|DONE|BLOCKED)$", content, re.M):
        errors.append(f"{path.name}: invalid status")
for path in [root / "README.md", *sorted((root / "docs").rglob("*.md"))]:
    if not path.is_file():
        continue
    for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", path.read_text(encoding="utf-8")):
        if "://" in target or target.startswith("#"):
            continue
        if not (path.parent / target.split("#", 1)[0]).exists():
            errors.append(f"{path.relative_to(root)}: broken link {target}")
if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print("Collaboration workspace checks passed.")
