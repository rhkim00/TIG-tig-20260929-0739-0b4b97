"""Validate the local task DAG; never assigns, executes, or infers remote completion."""
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[1]
tasks = {}
errors = []
for path in sorted((root / 'docs/coordination/tasks').glob('TH-*.md')):
    fields = dict(re.findall(r'^- ([^:]+): (.*)$', path.read_text(), re.M))
    tasks[path.stem] = fields | {'deps': re.findall(r'TH-\d{3}', fields.get('선행 작업', ''))}
for key, t in tasks.items():
    owner, reviewer = t.get('담당자'), t.get('리뷰어')
    if {owner, reviewer} != {'timeistoken', 'rhkim00'}:
        errors.append(f'{key}: invalid owner/reviewer')
    if t.get('상태') not in {'TODO', 'IN_PROGRESS', 'REVIEW', 'DONE', 'BLOCKED'}:
        errors.append(f'{key}: invalid status')
    for dep in t['deps']:
        if dep not in tasks:
            errors.append(f'{key}: missing dependency {dep}')
visited, visiting = set(), set()
def visit(key):
    if key in visiting:
        errors.append(f'Cycle at {key}')
        return
    if key in visited or key not in tasks:
        return
    visiting.add(key)
    for dep in tasks[key]['deps']:
        visit(dep)
    visiting.remove(key)
    visited.add(key)
for key in tasks:
    visit(key)
for owner in ('timeistoken', 'rhkim00'):
    active = [k for k,t in tasks.items() if t['담당자'] == owner and t.get('상태') == 'IN_PROGRESS']
    if len(active) > 1:
        errors.append(f'{owner}: multiple active implementation tasks {active}')
if errors:
    print('\n'.join(errors), file=sys.stderr)
    sys.exit(1)
print(f'Workflow valid: {len(tasks)} tasks, no dependency cycles.')
for owner in ('timeistoken', 'rhkim00'):
    active = [k for k,t in tasks.items() if t['담당자'] == owner and t.get('상태') == 'IN_PROGRESS']
    ready = [k for k,t in tasks.items() if t['담당자'] == owner and t.get('상태') == 'TODO'
             and all(tasks[d].get('상태') == 'DONE' for d in t['deps'])]
    print(f'{owner}: active={active}; local candidates={ready if not active else []}')
print('Local records only: verify prerequisite PR merges remotely before starting.')
