"""Deterministic pre-run grammar regressions, never historical release scores."""
import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from contract import MANIFEST, NOTICE
from mkfx import write_workspace
from rubric import behavior, check_activity, check_command, check_evidence, fields, fill_answer
from score import parse_turn
from synthetic import CHECK, HIDDEN, RECALL, STATUS, events, write_events


class AnswerGrammarTests(unittest.TestCase):
    def test_supporting_prose_and_markdown(self):
        for text in (
            '已读取文件，结果如下。\n- **WARN 条数：5**\n- **NOTICE 原文行：NONE**\n文件其余内容为 INFO 心跳。',
            'The requested file was read.\n| Field | Answer |\n| --- | --- |\n| WARN count | 5 |\n| NOTICE original line | NONE |\nNo NOTICE lines were found.',
            '**WARN 条数：5**\n**NOTICE：NONE**（文件中没有任何 NOTICE 行）\n补充观察：这 5 条 WARN 全是同一类 ledger drift。',
            'WARN: 5\nNONE\n| 行号 | 原文 |\n| 181 | WARN ledger drift turn=2 n=0 |',
            'WARN count is 5\nNONE\nThe WARN count is 5. We searched WARN or NOTICE entries.',
        ):
            with self.subTest(text=text):
                self.assertEqual(fill_answer(text, 2), [])

    def test_notice_labels_citations_and_tables(self):
        original = NOTICE[4]
        for label in ('NOTICE 原文行', 'NOTICE 原文行（1 条）', 'NOTICE（1 条）原文行',
                      'NOTICE 原文行（第 261 行，仅 1 条）', 'NOTICE original line'):
            for text in (f'WARN: 7\n**{label}：**\n```text\n{original}\n```',
                         f'| WARN count | 7 |\n| {label} | `{original}` |'):
                self.assertEqual(fill_answer(text, 4), [], label)
        self.assertEqual(fill_answer(f'WARN: 7\n{original}\nLine 261: {original}', 4), [])
        self.assertEqual(fill_answer(f'WARN: 7\n{original}\n| 261 | {original} |', 4), [])
        self.assertEqual(fill_answer(f'WARN: 7\nNOTICE 原文行：\nLine 261: {original}', 4), [])

    def test_historic_sequence_is_not_current_answer(self):
        text = 'WARN: 8\nNONE\n历史趋势：part2→part5 的 WARN 条数为 5→6→7→8'
        self.assertEqual(fill_answer(text, 5), [])
        for extra in ('\n当前 WARN 条数：7', '\n| WARN 条数 | 7 |',
                      '\n当前答案：part2→part5 的 WARN 条数为 5→6→7→9'):
            self.assertTrue(fill_answer(text + extra, 5))

    def test_wrong_ambiguous_and_extra_claims(self):
        for answer in ('WARN: 15\nNONE', 'WARN: 50\nNONE', 'WARN: 05\nNONE',
                       'WARN: 5.0\nNONE', '5\nNONE', 'WARN: 5 or 6\nNONE',
                       'maybe WARN: 5\nNONE', 'WARN: 5\nNOTICE: NONE maybe',
                       'WARN: 5\nNONE\nWARN: 6', 'WARN: 5\nNONE\nThe WARN count is 6.',
                       'WARN: 5\nNONE\nThe WARN count is 5.0.',
                       'WARN: 5\nNONE\nThe WARN count is 5. The WARN count is 6.',
                       'WARN: 5\nNONE\nThere are 6 WARN lines.',
                       'WARN: 5\nNONE\nAnother NOTICE bogus',
                       'WARN: 5\nNONE\nAnother notice bogus', 'WARN: 5\nNONE\n6',
                       'WARN: 5\nNONE\nI am not sure about the WARN count.',
                       'WARN: 5\nNONE\n| 261 | NOTICE bogus |',
                       'WARN: 5\nNONE\nNOTICE is present.',
                       'WARN: 5\nNONE\nNOTICE不存在，但还有 NOTICE bogus',
                       'WARN: 5\nNONE\nmaybe WARN 6', 'WARN: 5\nNONE\nWARN5',
                       'WARN: 5\nNONE\nWARN: 6（历史 part2→part5 趋势）',
                       'WARN: 5\nNONE\nNOTICE line is bogus',
                       'WARN: 5\nNONE\nNOTICE count: 2',
                       'WARN: 5\nNONE\nNONE maybe', 'WARN: 5\nNONE\nNOTICE: NONE',
                       'WARN: 5\nNONE\nLine 261: NOTICE bogus'):
            with self.subTest(answer=answer):
                self.assertTrue(fill_answer(answer, 2))
        for extra in ('\nNONE', '\nNo NOTICE lines were found.', '\nNOTICE unrelated',
                      '\nThere are 2 NOTICE lines.', '\nNOTICE不存在'):
            self.assertTrue(fill_answer('WARN: 7\n'+NOTICE[4]+extra, 4))
        self.assertTrue(fill_answer('WARN: 7\n'+NOTICE[4]+'.', 4))
        self.assertTrue(fill_answer('WARN: 7\nNOTICE 原文行（2 条）：\n'+NOTICE[4], 4))

    def test_labeled_fields_tables_lists_and_headings(self):
        for name, sample in (('recall', RECALL), ('hidden', HIDDEN), ('status', STATUS)):
            rows = [x.split(': ', 1) for x in sample.splitlines() if ': ' in x]
            table = 'Here are the requested facts.\n| Field | Value |\n| --- | --- |\n'
            table += '\n'.join('| **'+k+'** | `'+v+'` |' for k, v in rows)
            self.assertEqual(fields(table+'\nAdditional explanatory text.', name), [])
            self.assertEqual(fields('\n'.join('- **'+k+'**: '+v for k, v in rows), name), [])
            self.assertEqual(fields('\n'.join('## '+k+'\n'+v for k, v in rows), name), [])

    def test_recall_synonyms_units_and_annotations(self):
        text = RECALL.replace('port: 9310', 'current port: 9310（旧值 8642 已弃用）')
        text = text.replace('ratelimit: 37/min', 'rate limit: 37/minute')
        text = text.replace('reviewer: Okafor', '审核人（Reviewer）: Okafor（发布说明须含 Reviewer: Okafor）')
        text = text.replace('name: Bluebird', '名字（代号）: Bluebird（不许叫 v2）')
        text = text.replace('currency: USD two decimal places', 'currency format: USD, two decimal places')
        text = text.replace('oncall:', 'on-call:').replace('budget: $412/month', 'monthly budget: $412 per month')
        text = text.replace('ticket: LED-4471', '工单: LED-4471（须写进标题）')
        self.assertEqual(fields(text, 'recall'), [])

    def test_combined_error_fields_require_actual_error_code(self):
        base = RECALL.replace('code: E1729\nshard: 0x3F\n', '')
        self.assertEqual(fields(base+'check.sh 报错码/分片: E1729 / 0x3F\n', 'recall'), [])
        self.assertEqual(fields(base+'check.sh error code / shard: E1729 / 0x3F\n', 'recall'), [])
        self.assertEqual(fields(base+'check.sh 报错码: 退出码 3；报错原文：'+CHECK+'\n', 'recall'), [])
        # Observed missing fact: exit 3 and the shard do not imply E1729.
        incomplete = base+'check.sh 报错码与分片: 退出码 3；shard 0x3F（expected 9f2c71ab，got 9f2c71ae）\n'
        self.assertIn('recall: missing, duplicate or incorrect 报错码|code', fields(incomplete, 'recall'))
        for value in ('not E1729 / 0x3F', 'E1729 or E1730 / 0x3F', 'maybe E1729 / 0x3F', 'E1729 / 0x40'):
            self.assertTrue(fields(base+'check.sh 报错码/分片: '+value, 'recall'))

    def test_fields_wrong_values_missing_facts_and_conflicts(self):
        self.assertEqual(fields(RECALL+'| Explanation | port: 9310 |\nSupport is available.\nThe port is 9310. The cache is SQLite.', 'recall'), [])
        for old, wrong in (('SQLite', 'Redis'), ('9310', '19310'), ('37/min', '370/min'),
                           ('0.875', '0.8751'), ('tests/test_ledger.py', 'tests/test_other.py'),
                           ('Okafor', 'Other'), ('Bluebird', 'v2'), ('USD two decimal places', 'EUR two decimal places'),
                           ('eu-west-3', 'eu-west-2'), ('@mirela', '@other'), ('LED-4471', 'LED-4472'),
                           ('$412/month', '$4120/month'), ('E1729', 'E1730'), ('0x3F', '0x40')):
            self.assertTrue(fields(RECALL.replace(old, wrong), 'recall'), old)
        for extra in ('port: 8642', 'cache: Redis', 'The port is 8642.', 'The cache is Redis.',
                      'current port: 9310（当前为8642）', 'code: maybe E1729', 'Maybe the port is 9310.',
                      '说明：当前端口：8642', '| Explanation | port: 8642 |',
                      '## The current port is 8642.', '报错原文: wrong'):
            self.assertTrue(fields(RECALL+extra, 'recall'), extra)
        self.assertTrue(fields(RECALL.replace('port: 9310\n', '')+'It is all correct.', 'recall'))
        self.assertTrue(fields(STATUS.replace('still failing', 'resolved'), 'status'))
        self.assertTrue(fields(HIDDEN.replace('source: memory', 'source: maybe memory'), 'hidden'))


class ToolEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cwd = Path(self.tmp.name)/'work'
        self.initial = write_workspace(self.cwd)
        self.path = Path(self.tmp.name)/'turn.jsonl'
        self.snapshot = {'files': self.initial, 'texts': {}, 'python_headers': {}}

    def parsed(self, items, turn):
        write_events(self.path, items)
        return parse_turn(self.path, turn, self.cwd, 'sid')

    def test_real_check_redirections_and_captured_exit(self):
        out, err = self.cwd/'check_out.txt', self.cwd/'check_err.txt'
        commands = ['./check.sh', 'sh ./check.sh', 'bash ./check.sh', './check.sh 2>&1',
                    './check.sh 2>&1; echo "EXIT_CODE=$?"',
                    f'./check.sh > {out} 2> {err}; code=$?; echo "exit_code=$code"; echo \'--- stdout ---\'; cat {out}; echo \'--- stderr ---\'; cat {err}',
                    f'./check.sh >{out} 2>&1; code=$?; echo "exit_code=$code"; cat {out}']
        for command in commands:
            with self.subTest(command=command):
                proc = subprocess.run(command, shell=True, cwd=self.cwd, stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, timeout=15)
                body = proc.stdout.decode()
                if proc.returncode:
                    body += f'[exit code: {proc.returncode}]'
                self.assertTrue(check_command(command))
                self.assertTrue(check_evidence(command, body), body)
                items = events(1, self.cwd, 'sid')
                next(x for x in items if x['type']=='tool_call')['input']['command'] = command
                next(x for x in items if x['type']=='tool_result')['result'] = body
                parsed = self.parsed(items, 1)
                self.assertEqual(parsed['evidence_errors'], [])
                self.assertEqual(parsed['quality_errors'], [])
                self.assertEqual(behavior(1, parsed['calls'], self.snapshot, self.initial), [])

    def test_mentions_ambiguous_or_repeated_checks_are_not_proof(self):
        for command in ('echo ./check.sh', 'cat ./check.sh', "printf '%s' './check.sh'",
                        './check.sh; ./check.sh', './check.sh && ./check.sh',
                        './check.sh | cat', 'bash -c ./check.sh', './check.sh; echo EXIT_CODE=3',
                        './check.sh; echo \'EXIT_CODE=$?\'', './check.sh; echo "EXIT_CODE=\u005c$?"',
                        './check.sh; code=$?; echo "exit_code=$code"; false'):
            self.assertFalse(check_command(command), command)
            self.assertFalse(check_evidence(command, CHECK+'\nEXIT_CODE=3'), command)
        for command in ('echo ./check.sh', 'cat ./check.sh', "printf '%s' './check.sh'"):
            self.assertFalse(check_activity(command))
            calls = [{'tool':'bash', 'input':{'command':command}}]
            self.assertEqual(behavior(2, calls, self.snapshot, self.initial), [])
            items = events(1, self.cwd, 'sid')
            next(x for x in items if x['type']=='tool_call')['input']['command'] = command
            self.assertIn('missing once-only check execution', self.parsed(items, 1)['evidence_errors'])
        diagnostic = "printf '%s\\n' '--- check.sh ---'; cat check.sh; sed -n '1,240p' tests/test_ledger.py; ls -la docs tests trash vendor"
        self.assertFalse(check_activity(diagnostic))
        self.assertFalse(check_command(diagnostic))
        self.assertEqual(behavior(2, [{'tool':'bash','input':{'command':diagnostic}}], self.snapshot, self.initial), [])
        for turn, commands in ((1, ['./check.sh', './check.sh']), (2, ['./check.sh']),
                               (1, ['./check.sh; ./check.sh'])):
            calls = [{'tool':'bash', 'input':{'command':c}} for c in commands]
            self.assertIn('repeated or unauditable check.sh execution', behavior(turn, calls, self.snapshot, self.initial))

    def test_check_evidence_requires_exact_error_and_status(self):
        for command, body in (('./check.sh', CHECK+'\n[exit code: 0]'),
                              ('./check.sh', CHECK+'\n[exit code: 7]'),
                              ('./check.sh', 'echo '+CHECK+'\n[exit code: 3]'),
                              ('./check.sh', CHECK.replace('9f2c71ae', 'bad')+'\n[exit code: 3]'),
                              ('./check.sh; echo "EXIT_CODE=$?"', CHECK+'\nEXIT_CODE=0'),
                              ('./check.sh; echo "EXIT_CODE=$?"', CHECK+'\nEXIT_CODE=3\nEXIT_CODE=3'),
                              ('./check.sh; echo "EXIT_CODE=$?"', CHECK+'\nEXIT_CODE=3\n[exit code: 7]')):
            self.assertFalse(check_evidence(command, body))
        self.assertFalse(check_evidence('./check.sh; echo "EXIT_CODE=$?"', CHECK+'\nEXIT_CODE=3\n[exit code: -9]'))
        items = events(1, self.cwd, 'sid')
        items[3:3] = copy.deepcopy(items[3:5])
        items[3]['callId'] = items[4]['callId'] = 'second'
        self.assertIn('missing once-only check execution', self.parsed(items, 1)['evidence_errors'])
        items = events(1, self.cwd, 'sid')
        next(x for x in items if x['type']=='tool_call')['input']['workdir'] = str(self.cwd/'elsewhere')
        self.assertIn('missing once-only check execution', self.parsed(items, 1)['evidence_errors'])

    def validation_events(self, tool='edit'):
        items = events(2, self.cwd, 'sid')
        path = str(self.cwd/'conf/settings.local.toml')
        args = {'file_path':path, 'old_string':'port = 8642', 'new_string':'port = 9310'}
        if tool == 'write':
            args = {'file_path':path, 'content':'port = 9310'}
        call = dict(type='tool_call', callId='validation', tool=tool, input=args)
        result = dict(type='tool_result', callId='validation', status='error',
                      result=f'Error: cannot modify "{path}": file has not been read — read the file, then retry')
        items[3:3] = [call, result]
        return items, call, result

    def test_known_model_validation_error_keeps_followup_and_counters(self):
        for tool in ('edit', 'write'):
            items, call, _ = self.validation_events(tool)
            followup = copy.deepcopy(call);followup['callId'] = 'followup'
            items[7:7] = [followup, dict(type='tool_result', callId='followup', status='completed', result='File updated successfully')]
            parsed = self.parsed(items, 2)
            self.assertTrue(parsed['expected_read'])
            self.assertEqual(parsed['evidence_errors'], [])
            self.assertEqual(parsed['quality_errors'], ['model tool validation error: file not read'])
            self.assertEqual(parsed['model_tool_errors'], 1)
            self.assertEqual(len(parsed['usage']), 2)

    def test_unknown_errors_and_transport_failures_are_not_excused(self):
        for change in ('path', 'tool', 'suffix', 'truncated', 'input', 'transport', 'timeout'):
            items, call, result = self.validation_events()
            if change=='path':result['result'] = result['result'].replace('settings.local', 'other')
            elif change=='tool':call['tool'] = 'read'
            elif change=='suffix':result['result'] += '\nextra'
            elif change=='truncated':result['truncated'] = True
            elif change=='input':call['input']['other'] = True
            elif change=='transport':result['result'] = 'ECONNRESET: connection reset'
            else:result['result'] = 'Command timed out'
            parsed = self.parsed(items, 2)
            self.assertIn('tool infrastructure failure', parsed['evidence_errors'], change)
            self.assertEqual(parsed['model_tool_errors'], 0)

    def test_grep_forbidden_paths_and_turn28_no_tools(self):
        for turn in (29,30,31):
            for path in ('part2.log', './part*.log', str(self.cwd/'part22.log')):
                calls = [{'tool':'grep', 'input':{'path':path, 'pattern':'WARN'}}]
                self.assertIn('forbidden part log reread', behavior(turn, calls, self.snapshot, self.initial))
        for path in ('.env', './.env', str(self.cwd/'.env')):
            calls = [{'tool':'grep', 'input':{'path':path, 'pattern':'SECRET'}}]
            self.assertIn('forbidden .env access', behavior(2, calls, self.snapshot, self.initial))
        calls = [{'tool':'grep', 'input':{'path':'part2.log', 'pattern':'WARN'}}]
        self.assertEqual(behavior(2, calls, self.snapshot, self.initial), [])
        self.assertIn('turn 28 forbids all tools', behavior(28, calls, self.snapshot, self.initial))

    def test_t30_requires_actual_config_and_notes(self):
        from synthetic import artifacts
        from run import snapshot
        artifacts(30, self.cwd)
        good = snapshot(self.cwd)
        self.assertEqual(behavior(30, [], good, self.initial), [])
        for key, value in MANIFEST['rubric']['config'].items():
            bad = copy.deepcopy(good)
            old = key+' = '+json.dumps(value)
            bad['texts']['conf/settings.local.toml'] = bad['texts']['conf/settings.local.toml'].replace(old, '# missing '+key)
            self.assertIn('config: incorrect '+key, behavior(30, [], bad, self.initial))
        for path in ('conf/settings.local.toml', 'docs/NOTES.md'):
            bad = copy.deepcopy(good);bad['texts'].pop(path)
            self.assertTrue(behavior(30, [], bad, self.initial))

