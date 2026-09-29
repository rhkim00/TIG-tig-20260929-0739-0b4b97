#!/usr/bin/env python3
"""Git-based handoff validation and read-only remote coordination. No auto merge or task execution."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PEOPLE = {'timeistoken', 'rhkim00'}
def git(*args, check=True):
    p = subprocess.run(['git', *args], cwd=ROOT, text=True, capture_output=True)
    if check and p.returncode:
        raise ValueError(p.stderr.strip() or 'Git command failed')
    return p.stdout.strip()
def read_registry():
    return json.loads((ROOT/'docs/coordination/assignments.json').read_text())
def fields(record):
    needed = {'schemaVersion','task','author','createdAt','branch','baseCommit','status','summary','files','checks','blockers','next'}
    if not needed <= record.keys():
        raise ValueError('Handoff missing fields: '+', '.join(sorted(needed-record.keys())))
    if record['schemaVersion'] != 1 or record['author'] not in PEOPLE or not re.fullmatch(r'TH-\d{3}',record['task']):
        raise ValueError('Invalid handoff identity/schema')
    if record['status'] not in ['IN_PROGRESS','REVIEW','BLOCKED','DONE']:
        raise ValueError('Invalid handoff status')
    if not re.fullmatch(r'[a-f0-9]{40}',record['baseCommit']): raise ValueError('baseCommit must be a full Git SHA')
    dt.datetime.fromisoformat(record['createdAt'].replace('Z','+00:00'))
    if not isinstance(record['summary'],list) or not record['summary'] or not all(isinstance(x,str) and x.strip() for x in record['summary']):
        raise ValueError('Describe the actual changes in summary')
    if not isinstance(record['files'],list) or not all(isinstance(x,str) for x in record['files']): raise ValueError('files must be paths')
    if not isinstance(record['blockers'],list): raise ValueError('blockers must be a list')
    if not isinstance(record['checks'],list) or not record['checks']: raise ValueError('Record checks, including not_run with a reason')
    for c in record['checks']:
        if not all(isinstance(c.get(k),str) and c[k].strip() for k in ['command','result','details']) or c['result'] not in ['passed','failed','not_run']:
            raise ValueError('Every check needs command/result/details')
    if set(record['next']) != PEOPLE: raise ValueError('Record the next action for BOTH people')
    for person, action in record['next'].items():
        if not isinstance(action,dict) or not all(isinstance(action.get(k),str) and action[k].strip() for k in ['task','action','dependsOn']):
            raise ValueError(f'{person}: next task/action/dependsOn required')
    return record

def staged_paths(): return git('diff','--cached','--name-only','--diff-filter=ACDMRT').splitlines()
def log_path(p): return p.startswith('docs/handoffs/') and p.endswith('.json')
def validate_change(paths, read, person=None, statuses=None, registry=None):
    if not paths: return
    logs=[p for p in paths if log_path(p)]
    if not logs: raise ValueError('Include a new docs/handoffs/*.json record with this commit. Run team.py record after staging.')
    covered=set()
    for path in logs:
        if statuses and statuses.get(path)!='A': raise ValueError('Handoffs are append-only; add a correction record instead of editing history')
        record=fields(json.loads(read(path)))
        if person and record['author']!=person: raise ValueError('Handoff author does not match git config tig.person')
        registry=registry or read_registry()
        task=registry['tasks'].get(record['task'])
        if not task or task['owner']!=record['author']: raise ValueError('Task is not assigned to this author')
        if record['status']=='DONE' and not record.get('mergedPr'): raise ValueError('DONE needs a mergedPr evidence URL')
        if not set(record['files']) <= set(paths): raise ValueError('Handoff lists files not changed in this commit')
        for changed in record['files']:
            if not any(changed.startswith(scope) for scope in task['scope']):
                raise ValueError(f'{record["task"]} is not assigned {changed}; coordinate scope before editing')
        covered.update(record['files'])
    missing=set(paths)-set(logs)-covered
    if missing: raise ValueError('Handoff does not cover: '+', '.join(sorted(missing)))

def record_file(args):
    body=json.loads(Path(args.file).read_text())
    person=git('config','--get','tig.person',check=False)
    if person not in PEOPLE: raise ValueError('Run team.py setup --person timeistoken|rhkim00 in your OWN clone first')
    body.update(schemaVersion=1,author=person,createdAt=dt.datetime.now(dt.timezone.utc).isoformat(),branch=git('branch','--show-current'),baseCommit=git('rev-parse','HEAD'),files=[p for p in staged_paths() if not log_path(p)])
    fields(body)
    if not body['files']: raise ValueError('Stage the exact code/docs files first; never stage secrets')
    path=ROOT/'docs/handoffs'/body['task']/f'{dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")}-{person}.json'
    relative=path.relative_to(ROOT).as_posix()
    validate_change(body['files']+[relative],lambda _:json.dumps(body),person,{relative:'A'})
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(body,ensure_ascii=False,indent=2)+'\n')
    git('add','--',relative)
    print('Staged handoff: '+relative)

def check(args):
    if args.base:
        commits=git('rev-list','--reverse',f'{args.base}..{args.head}').splitlines()
        checked=0
        for commit in commits:
            if not git('ls-tree','--name-only',commit,'scripts/team.py'): continue
            parents=git('rev-list','--parents','-n','1',commit).split()[1:]
            if len(parents)!=1: continue  # merged commits are already checked individually
            rows=git('diff','--name-status','--no-renames',parents[0],commit).splitlines()
            statuses={row.split('\t',1)[1]:row.split('\t',1)[0] for row in rows}
            registry=json.loads(git('show',f'{commit}:docs/coordination/assignments.json'))
            validate_change(list(statuses),lambda p:git('show',f'{commit}:{p}'),statuses=statuses,registry=registry)
            checked+=1
        print(f'Validated {checked} commit handoffs. CI does not prove that reported checks actually ran.')
    else:
        if git('branch','--show-current')=='main': raise ValueError('Do not develop directly on main')
        person=git('config','--get','tig.person',check=False)
        if person not in PEOPLE: raise ValueError('Run team.py setup in your own clone')
        statuses={r.split('\t',1)[1]:r.split('\t',1)[0] for r in git('diff','--cached','--name-status','--no-renames').splitlines()}
        registry=json.loads(git('show',':docs/coordination/assignments.json'))
        validate_change(list(statuses),lambda p:git('show',f':{p}'),person,statuses,registry)
        print('Staged changes and handoff validated')

def setup(args):
    existing=git('config','--get','core.hooksPath',check=False)
    if existing and existing!='.githooks': raise ValueError(f'Existing hooksPath {existing}: integrate the handoff check there before replacing it')
    git('config','--local','tig.person',args.person);git('config','--local','core.hooksPath','.githooks')
    print('Handoff hook enabled for this clone. Git name/email and GitHub authentication were NOT changed.')
    print('Linked worktrees share this clone’s config/authentication. Teammates should use separate clones/accounts.')

def sync(args):
    remote_ok=True
    try: git('fetch','--prune','origin')
    except ValueError as e: print('REMOTE NOT VERIFIED: '+str(e));remote_ok=False
    gh=shutil.which('gh') or str(Path.home()/'.local/bin/gh')
    prs=[]
    try:
        p=subprocess.run([gh,'pr','list','--state','open','--limit','100','--json','number,title,headRefName,baseRefName,url,isDraft'],cwd=ROOT,text=True,capture_output=True,check=True)
        prs=json.loads(p.stdout)
    except (OSError,subprocess.CalledProcessError): print('Open PRs not verified. Check GitHub before starting overlapping work.')
    refs={'HEAD','origin/main'}|{f'origin/{p["headRefName"]}' for p in prs}
    state_path=Path(git('rev-parse','--git-path',f'team-seen-{args.person}.json'))
    if not state_path.is_absolute(): state_path=ROOT/state_path
    old=json.loads(state_path.read_text()) if state_path.exists() else {}
    current={};records={}
    print('\nLOCAL CHECKOUT (fetch does not change your code):\n'+git('status','--short','--branch'))
    for ref in sorted(refs):
        sha=git('rev-parse','--verify',ref,check=False)
        if not re.fullmatch('[a-f0-9]{40}',sha): continue
        current[ref]=sha
        if old.get(ref)!=sha:
            base=old.get(ref) or git('merge-base','origin/main',sha,check=False)
            print(f'\nUPDATED {ref} {sha[:8]}')
            if base: print(git('diff','--stat',base,sha,check=False))
        for path in git('ls-tree','-r','--name-only',ref,'docs/handoffs').splitlines():
            if not log_path(path): continue
            try:
                value=fields(json.loads(git('show',f'{ref}:{path}')))
                records[path]=(value,ref)
            except (ValueError,KeyError): print(f'INVALID HANDOFF: {ref}:{path}')
    for path,(r,ref) in sorted(records.items(),key=lambda item:item[1][0]['createdAt'])[-8:]:
        print(f'\n{r["createdAt"]} {r["author"]} {r["task"]} [{r["status"]}] ({ref})')
        for line in r['summary']: print('  Change: '+line)
        for c in r['checks']: print(f'  Check: {c["command"]} → {c["result"]}: {c["details"]}')
        for b in r['blockers']: print('  Blocker: '+b)
        for person,n in r['next'].items(): print(f'  NEXT {person}: {n["task"]} — {n["action"]} (depends: {n["dependsOn"]})')
        print('  Source: '+path)
    print('\nOPEN PRs (merge status must be verified separately):')
    for p in prs: print(f'  #{p["number"]} {p["headRefName"]} → {p["baseRefName"]}: {p["url"]}')
    print('\nASSIGNMENT: '+json.dumps(read_registry()['people'][args.person],ensure_ascii=False))
    print('Next actions in handoffs are proposals within the registered assignment. User-approved scope/assignments take precedence.')
    if remote_ok:
        state_path.parent.mkdir(parents=True,exist_ok=True);state_path.write_text(json.dumps(current)+'\n')

def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='command',required=True)
    p=sub.add_parser('setup');p.add_argument('--person',choices=sorted(PEOPLE),required=True);p.set_defaults(fn=setup)
    p=sub.add_parser('sync');p.add_argument('--person',choices=sorted(PEOPLE),required=True);p.set_defaults(fn=sync)
    p=sub.add_parser('record');p.add_argument('--file',required=True);p.set_defaults(fn=record_file)
    p=sub.add_parser('check');p.add_argument('--staged',action='store_true');p.add_argument('--base');p.add_argument('--head',default='HEAD');p.set_defaults(fn=check)
    args=parser.parse_args()
    try: args.fn(args)
    except (ValueError,KeyError,json.JSONDecodeError) as e: print('Team check: '+str(e),file=sys.stderr);return 1
    return 0
if __name__=='__main__':sys.exit(main())
