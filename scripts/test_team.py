import copy
import json
import unittest
import team

class HandoffChecks(unittest.TestCase):
    def setUp(self):
        self.path='docs/handoffs/TH-030/test.json'
        self.file='apps/web/src/view.tsx'
        self.registry={'tasks':{'TH-030':{'owner':'rhkim00','scope':['apps/web/']}}}
        self.record={'schemaVersion':1,'task':'TH-030','author':'rhkim00','createdAt':'2026-09-09T00:00:00+00:00','branch':'feat/test','baseCommit':'a'*40,'status':'IN_PROGRESS','summary':['Added an accessible result view.'],'files':[self.file],'checks':[{'command':'npm test','result':'not_run','details':'Waiting for the backend contract.'}],'blockers':[],'next':{p:{'task':'TH-030' if p=='rhkim00' else 'TH-029','action':'Review the contract','dependsOn':'API fixture'} for p in team.PEOPLE}}
    def validate(self,record=None,paths=None,status='A'):
        team.validate_change(paths or [self.file,self.path],lambda _:json.dumps(record or self.record),'rhkim00',{self.path:status},self.registry)
    def test_valid_record(self): self.validate()
    def test_log_required(self):
        with self.assertRaises(ValueError): self.validate(paths=[self.file])
    def test_both_next_actions_required(self):
        record=copy.deepcopy(self.record);del record['next']['timeistoken']
        with self.assertRaises(ValueError): self.validate(record)
    def test_scope_violation(self):
        record=copy.deepcopy(self.record);record['files']=['apps/api/src/server.ts']
        with self.assertRaises(ValueError):self.validate(record,record['files']+[self.path])
    def test_immutable_history(self):
        with self.assertRaises(ValueError):self.validate(status='M')
    def test_uncovered_file(self):
        with self.assertRaises(ValueError):self.validate(paths=[self.file,'apps/web/src/other.tsx',self.path])
    def test_done_needs_merge_evidence(self):
        record=copy.deepcopy(self.record);record['status']='DONE'
        with self.assertRaises(ValueError):self.validate(record)
if __name__=='__main__':unittest.main()
