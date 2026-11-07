import contextlib
import copy
import json
import tempfile
import subprocess
import sys
import unittest
from pathlib import Path
from contract import HERE, FILL, MANIFEST, read_json, sha, validate_contract
from mkfx import build_log, write_workspace
from rubric import fill_answer, fields, behavior
from score import compare, parse_turn, score_cell, ratios
from synthetic import RECALL, HIDDEN, STATUS, cell, events, write_events


class GrammarTests(unittest.TestCase):
    def test_exact_answers(self):
        for turn in FILL:
            expected = 'WARN: '+str(3+turn%9)+'\n'+MANIFEST['notices'].get(str(turn), 'NONE')
            self.assertEqual(fill_answer(expected, turn), [])

    def test_substrings_and_ambiguity(self):
        for text in ('WARN: 15\nNONE', 'WARN: 50\nNONE', 'part5.log\nNONE',
                     'not WARN: 5\nNONE', 'WARN: 5 or 6\nNONE', 'WARN: 5\nWARN: 5\nNONE',
                     'WARN: 5\nNONE\nNOTICE unexpected', 'WARN: 5?\nNONE',
                     'WARN: 5\nNOTICE: NONE maybe', 'WARN: 5\nNOTICE unexpected NONE'):
            with self.subTest(text=text):
                self.assertTrue(fill_answer(text, 2))
        self.assertTrue(fill_answer('WARN: 7\nNOTICE cache layer pinned to sqlite extra', 4))
        self.assertTrue(fill_answer('WARN: 7\nNOTICE cache layer pinned to sqlite\nNONE', 4))

    def test_memory_rubric(self):
        for name, text in [('recall',RECALL), ('hidden',HIDDEN), ('status',STATUS)]:
            self.assertEqual(fields(text, name), [])
        self.assertTrue(fields(RECALL.replace('port: 9310', 'port: 19310'), 'recall'))
        self.assertTrue(fields(RECALL+'port: 8642\n', 'recall'))
        self.assertTrue(fields(STATUS.replace('still failing','resolved'), 'status'))
        self.assertTrue(fields(HIDDEN.replace('9f2c71ab', '9f2c71ae'), 'hidden'))

    def test_fixture_and_prompts_frozen(self):
        prompts = validate_contract()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)/'work'
            inventory = write_workspace(root)
            self.assertNotIn('truth.json', inventory)
            for turn in FILL:
                self.assertEqual((root/f'part{turn}.log').read_text(), build_log(turn)[0])
            self.assertIn('batch_size=250', prompts[12]['prompt'])
            self.assertEqual((root/'part13.log').read_text().splitlines()[300], 'INFO hidden batch_size 250')
            # Original non-oracle files only. Frozen independently against d9391c5.
            original = {k:v for k,v in inventory.items() if k != 'part13.log'}
            digest = sha(json.dumps(original, sort_keys=True).encode())
            self.assertEqual(digest, ORIGINAL_FIXTURES_SHA256)

    def test_cache_write_and_weighting(self):
        data = [dict(inputTokens=10,cacheReadTokens=990,cacheWriteTokens=100,outputTokens=1),
                dict(inputTokens=90,cacheReadTokens=10,cacheWriteTokens=0,outputTokens=1)]
        result = ratios(data)
        self.assertAlmostEqual(result['read_over_read_plus_input'], 1000/1100)
        self.assertAlmostEqual(result['actual_prompt_read_ratio'], 1000/1200)
        self.assertEqual(result['cacheWriteTokens'], 100)
        data[0].pop('cacheWriteTokens')
        self.assertIsNone(ratios(data)['actual_prompt_read_ratio'])


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cwd = Path(self.tmp.name)/'work'
        self.cwd.mkdir()
        self.path = Path(self.tmp.name)/'turn.jsonl'
        self.items = events(2, self.cwd, 'sid')

    def check_bad(self, items=None):
        write_events(self.path, items if items is not None else self.items)
        try:
            parsed = parse_turn(self.path, 2, self.cwd, 'sid')
        except (ValueError, KeyError, TypeError):
            return
        self.assertTrue(parsed['evidence_errors'] or parsed['quality_errors'])

    def test_empty_final(self):
        self.items[-1]['text'] = ''
        self.check_bad()

    def test_missing_final(self):
        self.check_bad(self.items[:-1])

    def test_numeric_substring(self):
        self.items[-1]['text'] = 'WARN: 15\nNONE'
        self.check_bad()

    def test_tool_result_id_mismatch(self):
        next(x for x in self.items if x['type']=='tool_result')['callId'] = 'other'
        self.check_bad()

    def test_wrong_expected_filename(self):
        next(x for x in self.items if x['type']=='tool_call')['input']['file_path'] = 'part3.log'
        self.check_bad()

    def test_result_filename_mismatch(self):
        tool = next(x for x in self.items if x['type']=='tool_result')
        tool['result'] = tool['result'].replace('part2.log','part3.log')
        self.check_bad()

    def test_fake_read_unrelated_output(self):
        next(x for x in self.items if x['type']=='tool_result')['result'] = '5'
        self.check_bad()

    def test_tool_error(self):
        next(x for x in self.items if x['type']=='tool_result')['status'] = 'error'
        self.check_bad()

    def test_missing_usage(self):
        next(x for x in self.items if x.get('phase')=='step_end').pop('usage')
        self.check_bad()

    def test_optional_fields_are_optional(self):
        for ev in self.items:
            if 'usage' in ev:
                for key in ('cacheReadTokens','cacheWriteTokens','totalTokens'):
                    ev['usage'].pop(key)
        write_events(self.path, self.items)
        result = parse_turn(self.path,2,self.cwd,'sid')
        self.assertEqual(result['evidence_errors'], [])
        self.assertIsNone(ratios(result['usage'])['read_over_read_plus_input'])
        self.assertIsNone(result['transport_retries'])
        self.assertIsNone(result['request_finish_reason'])

    def test_completed_shell_nonzero_is_failure(self):
        self.items.insert(3,dict(type='tool_call',callId='shell',tool='bash',input={'command':'false'}))
        self.items.insert(4,dict(type='tool_result',callId='shell',status='completed',result='[exit code: 7]'))
        self.check_bad()

    def test_projection_truncation_preserves_real_read_proof(self):
        result=next(x for x in self.items if x['type']=='tool_result')
        result['truncated']=True
        result['result']=result['result'].split('\n</content>')[0]+'\n2: INFO incomplete pro'
        write_events(self.path,self.items)
        parsed=parse_turn(self.path,2,self.cwd,'sid')
        self.assertEqual(parsed['evidence_errors'],[])
        self.assertEqual(parsed['projection_truncations'],1)
        next(x for x in self.items if x['type']=='tool_call')['truncated']=True
        self.check_bad()

    def test_missing_first_usage_never_becomes_second_step(self):
        next(x for x in self.items if x.get('phase')=='step_end').pop('usage')
        write_events(self.path,self.items)
        parsed=parse_turn(self.path,2,self.cwd,'sid')
        self.assertTrue(parsed['usage'])
        self.assertIsNone(parsed['first_step_usage'])
        self.assertTrue(parsed['evidence_errors'])

    def test_missing_last_usage_never_uses_earlier_request(self):
        steps=[x for x in self.items if x.get('phase')=='step_end']
        steps[-1].pop('usage')
        write_events(self.path,self.items)
        parsed=parse_turn(self.path,2,self.cwd,'sid')
        self.assertIsNotNone(parsed['first_step_usage'])
        self.assertIsNone(parsed['last_step_usage'])
        self.assertTrue(parsed['evidence_errors'])

    def test_session_reset(self):
        self.items[0]['sessionId']='new-session'
        self.check_bad()

    def test_malformed_events(self):
        for raw in ('{broken}\n', 'banner\n', '{"type":"session","type":"final"}\n',
                    '{"type":"status","usage":NaN}\n', '[]\n', '{"type":"error"}'):
            self.path.write_text(raw)
            with self.assertRaises((ValueError, KeyError, TypeError)):
                parse_turn(self.path,2,self.cwd,'sid')

    def test_step_pairing_and_turn_termination(self):
        for index, change in [(1,{'turn':1}), (2,{'step':9}), (-2,{'reason':{'kind':'error'}})]:
            items = copy.deepcopy(self.items)
            items[index].update(change)
            self.check_bad(items)

    def test_double_final_and_unknown_type(self):
        self.check_bad(self.items + [dict(type='final',text='WARN: 5\nNONE')])
        self.check_bad(self.items[:-1]+[dict(type='made_up')]+self.items[-1:])


class FullCellTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)/'candidate'
        cls.stock = Path(cls.tmp.name)/'stock'
        cell(cls.root)
        cell(cls.stock,'stock')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    @contextlib.contextmanager
    def changed(self, path, data):
        old = path.read_bytes() if path.exists() else None
        path.write_bytes(data)
        try:
            yield
        finally:
            if old is None:
                path.unlink()
            else:
                path.write_bytes(old)

    @contextlib.contextmanager
    def bad_answer(self, root):
        path = root/'runs/spine-1/t2.jsonl'
        items = [json.loads(x) for x in path.read_text().splitlines()]
        items[-1]['text'] = 'WARN: 15\nNONE'
        data = ''.join(json.dumps(x)+'\n' for x in items).encode()
        with contextlib.ExitStack() as stack:
            stack.enter_context(self.changed(path, data))
            for suffix in ('.meta.json','.process.json'):
                target=path.with_suffix(suffix)
                meta=read_json(target);meta['stdout_sha256']=sha(data)
                stack.enter_context(self.changed(target,json.dumps(meta).encode()))
            yield

    def test_complete_fixed_denominator(self):
        report=score_cell(self.root)
        self.assertTrue(report['gate_pass'], report['evidence_errors'][:3]+report['quality_errors'][:3])
        self.assertEqual((report['complete_turns'],report['planned_turns'],report['fill_correct'],report['planned_fill']), (310,310,230,230))
        self.assertEqual(report['groups'][0]['t27_last_request_totalTokens'],1011)
        self.assertEqual(report['groups'][0]['t31_last_request_totalTokens'],1010)
        self.assertGreater(report['first_step']['read_over_read_plus_input'],report['all_steps']['read_over_read_plus_input'])
        self.assertFalse(report['cache_release_pass'])
        self.assertFalse((self.root/'work/spine-1/recall.md').exists())

    def test_candidate_wrong_nonzero_stock_wrong_reported(self):
        for root in (self.root,self.stock):
            with self.bad_answer(root):
                report=score_cell(root)
                self.assertTrue(report['evidence_pass'])
                self.assertEqual(report['fill_correct'],229)
                self.assertFalse(report['answer_pass'])
                self.assertEqual(report['gate_pass'],root == self.stock)

    def test_wrong_candidate_cli_nonzero(self):
        with self.bad_answer(self.root):
            result=subprocess.run([sys.executable,str(HERE/'score.py'),'--root',str(self.root)],
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
            self.assertEqual(result.returncode,1,result.stderr.decode())
            self.assertFalse(json.loads(result.stdout)['gate_pass'])

    def test_artifact_text_must_match_actual_file_hash(self):
        path=self.root/'runs/spine-1/t29.snapshot.json'
        meta_path=self.root/'runs/spine-1/t29.meta.json'
        snap=read_json(path);snap['files'].pop('hidden.md')
        data=json.dumps(snap).encode()
        meta=read_json(meta_path);meta['snapshot_sha256']=sha(data)
        with self.changed(path,data),self.changed(meta_path,json.dumps(meta).encode()):
            self.assertFalse(score_cell(self.root)['gate_pass'])

    def test_stale_group_marker_rejected(self):
        with self.changed(self.root/'runs/spine-1/DONE',b'DONE\n'):
            self.assertFalse(score_cell(self.root)['gate_pass'])

    def test_missing_turn_not_skipped(self):
        path=self.root/'runs/spine-1/t31.jsonl'
        old=path.read_bytes();path.unlink()
        try:
            report=score_cell(self.root)
            self.assertFalse(report['gate_pass'])
            self.assertEqual(report['planned_turns'],310)
            self.assertEqual(report['complete_turns'],309)
        finally:
            path.write_bytes(old)

    def test_stock_incomplete_rejected(self):
        path=self.stock/'runs/spine-1/t2.jsonl'
        with self.changed(path,b'{}\n'):
            self.assertFalse(score_cell(self.stock)['gate_pass'])

    def test_stale_done_and_changed_code(self):
        with self.changed(self.root/'DONE',b'DONE\n'):
            self.assertFalse(score_cell(self.root)['gate_pass'])
        path=self.root/'attempt.json';run=read_json(path)
        run['fingerprints']['score.py']='bad'
        with self.changed(path,json.dumps(run).encode()):
            with self.assertRaises(ValueError):
                score_cell(self.root)

    def test_late_turn_rubric_and_no_tools(self):
        group=self.root/'runs/spine-1'
        initial=read_json(group/'initial.json')
        for turn in (29,30,31):
            snap=read_json(group/f't{turn}.snapshot.json')
            self.assertEqual(behavior(turn,[],snap,initial),[])
            key={29:'hidden.md',30:'conf/settings.local.toml',31:'docs/STATUS.md'}[turn]
            snap['texts'][key]=''
            self.assertTrue(behavior(turn,[],snap,initial))
        snap=read_json(group/'t28.snapshot.json')
        call=dict(tool='read',input={'file_path':'recall.md'})
        self.assertTrue(behavior(28,[call],snap,initial))
        for call in (dict(tool='bash',input={'command':'./check.sh'}), dict(tool='read',input={'file_path':'part22.log'})):
            self.assertTrue(behavior(29,[call],snap,initial))

    def test_cache_comparability_and_frozen_budgets(self):
        a,b=score_cell(self.root),score_cell(self.stock)
        report=compare(a,b)
        self.assertTrue(report['cache_comparison_pass'],report)
        self.assertFalse(report['cache_release_pass'])
        for key in ('model','route','host','dependencies','parameters','cache_warmup','usage_semantics','package_sha256'):
            bad=copy.deepcopy(b);bad['spec'][key]='different'
            self.assertFalse(compare(a,bad)['cache_comparison_pass'],key)
        bad=copy.deepcopy(a);bad['first_step']['read_over_read_plus_input']=.98
        self.assertFalse(compare(bad,b)['cache_comparison_pass'])
        bad=copy.deepcopy(a);bad['all_steps']['inputTokens']*=1.051
        self.assertFalse(compare(bad,b)['cache_comparison_pass'])
        bad=copy.deepcopy(a);bad['all_steps']['cacheWriteTokens']=None
        self.assertFalse(compare(bad,b)['cache_comparison_pass'])
        bad=copy.deepcopy(b);bad['evidence_pass']=False
        self.assertFalse(compare(a,bad)['cache_comparison_pass'])


# Filled from original d9391c5 generator, excluding its leaked truth.json.
ORIGINAL_FIXTURES_SHA256 = 'c2e032ec2e217bbf89e8949b59e29d8c73ebad932a137160187e1ee7c0b0a1e5'
