"""Real stdlib import provenance plus inert behavior gates; synthetic files only."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from command_audit import OPAQUE, tool_errors


class PythonIsolationTests(unittest.TestCase):
    def test_real_workspace_module_shadowing_and_isolation(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            (root/'part14.log').write_text('SYNTHETIC_IMPORT_CANARY')
            module='# owner: team-kestrel'+chr(10)+'print(open("part14.log").read())'+chr(10)
            (root/'csv.py').write_text(module)
            (root/'sample.csv').write_text('a,b'+chr(10)+'1,2'+chr(10))
            env={'PATH':os.environ['PATH'],'PYTHONDONTWRITEBYTECODE':'1'}
            def run(*args):
                return subprocess.check_output([sys.executable,*args],cwd=root,env=env,text=True,timeout=10)
            self.assertEqual(run('-c','import csv').strip(),'SYNTHETIC_IMPORT_CANARY')
            self.assertEqual(run('-I','-c','import csv'), '')
            self.assertEqual(run('-I','-c','import csv; print(list(csv.reader(open("sample.csv"))))').strip(),"[['a', 'b'], ['1', '2']]")
            self.assertEqual(run('-I','-c','from pathlib import Path; print(Path("sample.csv").read_text())').strip(),'a,b'+chr(10)+'1,2')
            self.assertEqual(tool_errors({'tool':'write','input':{'file_path':'csv.py','content':module}},27,cwd=root),[])
            self.assertIn(OPAQUE,tool_errors({'tool':'bash','input':{'command':"python3 -c 'import csv'"}},29,cwd=root))

    def test_nonisolated_and_ambiguous_flags_are_rejected(self):
        for command in ("python3 -c 'import csv'", "python -c 'print(1)'",
                        "python3 -E -c 'import json'", "python3 -s -c 'import pathlib'",
                        "python3 -I -m csv", "python3 -I -c 'print(1)' extra"):
            with self.subTest(command=command):
                self.assertIn(OPAQUE,tool_errors({'tool':'bash','input':{'command':command}},29))

    def test_isolated_standard_library_literal_readers_remain_allowed(self):
        for source in ('import csv; print(list(csv.reader(open("sample.csv"))))',
                       'from pathlib import Path; print(Path("sample.csv").read_text())',
                       'print(open("sample.csv").read())'):
            for command in ('python3','python','/usr/bin/python3'):
                with self.subTest(source=source,command=command):
                    self.assertEqual(tool_errors({'tool':'bash','input':{'command':command+" -I -c '"+source+"'"}},14),[])

    def test_isolation_does_not_waive_forbidden_paths_or_bindings(self):
        for source in ('print(open("part14.log").read())',
                       'from pathlib import Path as str; str("part" + "14.log").read_text()',
                       chr(10).join(['match open:','    case str:','        str("part" + "14.log").read()'])):
            with self.subTest(source=source):
                self.assertTrue(tool_errors({'tool':'bash','input':{'command':"python3 -I -c '"+source+"'"}},29))


    def test_workspace_scope_rejects_external_paths_and_redirects(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'workspace';root.mkdir()
            outside=Path(temp)/'outside.txt';outside.write_text('synthetic')
            for call in ({'tool':'read','input':{'file_path':str(outside)}},
                         {'tool':'write','input':{'file_path':str(outside),'content':'synthetic'}},
                         {'tool':'bash','input':{'command':"printf safe > '"+str(outside)+"'"}},
                         {'tool':'bash','input':{'command':"python3 -I -c 'print(open(\""+str(outside)+"\").read())'"}}):
                self.assertIn(OPAQUE,tool_errors(call,14,cwd=root))
            self.assertEqual(outside.read_text(),'synthetic')

    def test_workspace_symlink_cannot_grant_external_file_access(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'workspace';root.mkdir()
            outside=Path(temp)/'outside.txt';outside.write_text('synthetic')
            (root/'link.txt').symlink_to(outside)
            self.assertIn(OPAQUE,tool_errors({'tool':'read','input':{'file_path':'link.txt'}},14,cwd=root))
            self.assertIn(OPAQUE,tool_errors({'tool':'write','input':{'file_path':'link.txt','content':'safe'}},14,cwd=root))

    def test_workspace_scope_preserves_absolute_local_paths_and_resets(self):
        with tempfile.TemporaryDirectory() as temp:
            roots=[Path(temp)/name for name in ('first','second')]
            for root in roots:root.mkdir()
            path=roots[1]/'sample.csv';path.write_text('a,b')
            call={'tool':'read','input':{'file_path':str(path)}}
            self.assertIn(OPAQUE,tool_errors(call,14,cwd=roots[0]))
            self.assertEqual(tool_errors(call,14,cwd=roots[1]),[])
            self.assertEqual(tool_errors({'tool':'read','input':{'file_path':'sample.csv'}},14,cwd=roots[0]),[])
