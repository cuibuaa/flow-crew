#!/usr/bin/env python3
"""Historical validation-budget native replay, no providers.

Its pinned base predates this round; use the current regression specs against
the round base for current before/after claims.

The author-stage default is scaled to 180 seconds in both private engine copies.
--fixture-load explicitly declares a permissive ceiling with raw host telemetry
retained, to exercise measured negative evidence on an overloaded host. The candidate's 60-second whole-batch default and base's 45-minute
per-command default are preserved. Commands need 240 seconds or never finish.
The common 120-second observation therefore distinguishes gate liveness.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

BASE = '7d1ee7db0452b3860d3b3d1a99a076599754406a'

def run(argv, cwd, **kwargs):
    return subprocess.run(['nice', '-n', '19', *argv], cwd=cwd, timeout=kwargs.pop('timeout', 180), **kwargs)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--tree', choices=['base', 'final'], required=True)
    parser.add_argument('--shape', choices=['slow', 'silent', 'build-silent'], required=True)
    parser.add_argument('--scratch-root', type=Path)
    parser.add_argument('--harness', type=Path, default=Path.home() / 'bin/fc-trial')
    parser.add_argument('--fixture-capacity', action='store_true')
    parser.add_argument('--fixture-load', action='store_true')
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    args.evidence.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix='probe-trial-', dir=args.scratch_root or os.environ['TMPDIR']))
    engine = scratch / 'engine'; engine.mkdir()
    listing = run(['git', 'ls-tree', '-r', '--name-only', '-z', BASE] if args.tree == 'base' else ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], repo, capture_output=True, check=True).stdout
    for file in listing.decode().split('\0'):
        if not file or file.startswith(('node_modules/', 'ui/node_modules/', 'dist/', 'ui/dist/')): continue
        if Path(file).name in ['auth.json', 'credentials.json', 'installation_id'] or Path(file).name.startswith('.env'): continue
        source = repo / file
        if not source.is_file(): continue
        target = engine / file; target.parent.mkdir(parents=True, exist_ok=True)
        if args.tree == 'base': target.write_bytes(run(['git', 'show', BASE + ':' + file], repo, capture_output=True, check=True).stdout)
        else: shutil.copy2(source, target)
    # Fixture-only time scaling, identical on both sides; no production bytes change.
    defaults = engine / 'config/defaults.yaml'
    settings = defaults.read_text().replace('default_timeout_ms: 10800000', 'default_timeout_ms: 180000')
    if args.fixture_load: settings = settings.replace('validation_load_ceiling_per_cpu: 1', 'validation_load_ceiling_per_cpu: 100').replace('validation_load_wait_seconds: 1', 'validation_load_wait_seconds: 0')
    defaults.write_text(settings)
    for file in ['node_modules', 'ui/node_modules']:
        (engine / file).symlink_to(repo / file, target_is_directory=True)
    for argv in [['git','init','-q'], ['git','config','user.name','Trial'], ['git','config','user.email','trial@example.invalid'], ['git','add','.'], ['git','commit','-qm','private scaled fixture']]:
        run(argv, engine, capture_output=True, check=True)
    program = 'setTimeout(()=>{},240000)' if args.shape == 'slow' else 'setInterval(()=>{},1000)'
    commands = {'test': {'command': 'node', 'args': ['-e', program]}}
    if args.shape == 'build-silent': commands = {'build': {'command': 'node', 'args': ['-e', 'process.exitCode=2']}, **commands}
    brief = scratch / 'brief.md'
    brief.write_text('---\nworkflow: direct\ninputs: [notes.md, evidence]\noutputs: [docs/report.md, docs/details.md]\nvalidation: ' + json.dumps({'commands': commands}) + '\n---\n# Write a greeting\n\nUse the declared evidence to write the same greeting in both artifacts.\n\n## What the report must show\n1. Both artifacts contain the greeting supported by the declared evidence.\n2. The declared source inputs retain their original content.\n')
    decision = {'reason': 'Deterministic validation-budget fixture.', 'assumptions': [], 'metric_search': False, 'missing_author_facts': []}
    scripts = {'choose': {'output': {**decision, 'successor': 'implement'}},
        'assess': {'output': {'reason': 'Read product and available validation facts.', 'successor': 'review', 'risk_areas': [{'file':'docs/report.md','risk':'Greeting validity','experiment':'Read both greeting outputs and the stated validation facts.'}]}},
        'implement': {'output': {'status':'delivered','summary':'Greeting artifacts complete.','caveats':[],'remaining_work':[]}}}
    replies = scratch / 'replies.json'; replies.write_text(json.dumps(scripts, indent=2) + '\n')
    started = time.time()
    command = [str(args.harness),'launch','--worktree',str(engine),'--brief',str(brief),'--script',str(replies),'--background','--timeout','120']
    live_log = scratch / 'harness.log'
    with live_log.open('wb') as log:
        child = subprocess.Popen(['nice', '-n', '19', *command], cwd=repo, stdout=log, stderr=subprocess.STDOUT)
        patched = False
        declared = False
        while child.poll() is None:
            if time.time() - started > 1080:
                child.terminate(); child.wait(timeout=20)
                raise RuntimeError('Owned fc-trial exceeded the invocation bound')
            lines = live_log.read_text(errors='replace').splitlines()
            locator = next((line.split('receipts=', 1)[1] for line in lines if 'receipts=' in line), None)
            if args.fixture_capacity and locator and not patched:
                guard = Path(locator) / 'home/bin/disk-guard'
                if guard.exists():
                    original = guard.read_bytes()
                    if b'/disk-guard' not in original or not original.startswith(b'#!/bin/sh'): raise RuntimeError('Unexpected private capacity fixture')
                    (Path(locator) / 'disk-guard-original').write_bytes(original)
                    guard.write_text("#!/usr/bin/python3\nimport os,sys,json\nfrom pathlib import Path\nrequested=int(sys.argv[-1]);free=os.statvfs('/').f_bavail*os.statvfs('/').f_frsize\nrecord={'fixture':True,'requested':requested,'actual_free_bytes':free,'production_reserve_not_exercised':True}\nPath(" + repr(str(Path(locator) / 'capacity-fixture.json')) + ").write_text(json.dumps(record)+'\\n')\nprint(json.dumps(record));sys.exit(0 if 0<=requested<=1048576 and free>requested else 1)\n")
                    patched = True
            if locator and not declared:
                fixture_project = Path(locator) / 'project'
                if (fixture_project / '.git/HEAD').exists() and run(['git','rev-parse','--verify','HEAD'], fixture_project, capture_output=True).returncode == 0:
                    (fixture_project / 'config').mkdir(exist_ok=True)
                    (fixture_project / 'config/validation.json').write_text(json.dumps({'commands': commands}) + '\n')
                    edits = []
                    for argv in [['git','add','config/validation.json'], ['git','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','Declare the trial validation commands']]:
                        result = run(argv, fixture_project, capture_output=True, check=True)
                        edits.append({'command': argv, 'exit': result.returncode})
                    (Path(locator) / 'fixture-inputs.json').write_text(json.dumps({'declaration':commands,'commands':edits}, indent=2) + '\n')
                    declared = True
            time.sleep(0.1)
    completed = subprocess.CompletedProcess(command, child.returncode, live_log.read_bytes(), b'')
    (args.evidence / 'wrapper.log').write_bytes(completed.stdout + completed.stderr)
    (args.evidence / 'brief.md').write_bytes(brief.read_bytes()); (args.evidence / 'replies.json').write_bytes(replies.read_bytes())
    # The harness prints a structured receipt locator in its first line.
    lines = completed.stdout.decode(errors='replace').splitlines()
    located = next((line.split('receipts=', 1)[1] for line in lines if 'receipts=' in line), None)
    if located is None: located = next(line.split('result=', 1)[1] for line in lines if 'result=' in line).removesuffix('/result.json')
    receipt_root = Path(located)
    shutil.copytree(receipt_root, args.evidence / 'receipt', dirs_exist_ok=True, symlinks=True,
        ignore=shutil.ignore_patterns('engine','home','tmp','codex','config','cache','runtime','npm-cache','project','target','*.sock'))
    result = json.loads((receipt_root / 'result.json').read_text())
    invocations = [json.loads(line) for line in (receipt_root / 'invocations.jsonl').read_text().splitlines()] if (receipt_root / 'invocations.jsonl').exists() else []
    gate = [call for call in invocations if call['stage'] == 'review']
    runs = list((receipt_root / 'fc/runs').glob('*/run.json'))
    state = json.loads(runs[0].read_text()) if len(runs) == 1 else {}
    author = state.get('stages', {}).get('implement', {})
    ledger = [json.loads(line) for line in (runs[0].parent / 'evidence-ledger.jsonl').read_text().splitlines()] if runs else []
    validation = [fact for fact in ledger if fact['kind'] == 'validation']
    facts = {'tree': args.tree, 'shape': args.shape, 'base': BASE, 'command': command, 'direct_harness_exit': completed.returncode,
        'elapsed_s': time.time() - started, 'harness_result': result, 'gate_invocations': gate,
        'author_status': author.get('status'), 'author_exit': author.get('exitCode'), 'validation': validation,
        'scale': {'default_timeout_ms': 180000, 'observation_seconds': 120, 'eventual_command_ms': 240000, 'validation_load_ceiling_per_cpu': 100 if args.fixture_load else 1, 'validation_load_wait_seconds': 0 if args.fixture_load else 1},
        'expected_negative_wrapper': args.tree == 'base', 'capacity_fixture': args.fixture_capacity, 'project_declaration_fixture': declared}
    if args.tree == 'base':
        passed = completed.returncode != 0 and not gate and author.get('status') == 'complete' and 'Timed out terminal outcome' in result.get('error', '')
    else:
        passed = completed.returncode == 0 and bool(gate) and author.get('status') == 'complete' and len(validation) == 1
        if validation:
            commands = validation[0]['executions'][0]['commands']
            passed = passed and any(command.get('unfinished') is True and command['state'] == 'unverified' for command in commands)
            passed = passed and len(validation[0]['executions']) == 1 and validation[0]['pass'] is False
            if args.shape == 'build-silent': passed = passed and commands[0].get('exitCode') == 2 and commands[0]['state'] == 'failed' and commands[0]['measurement'] == 'unverified'
    facts['proof_passed'] = passed
    (args.evidence / 'proof.json').write_text(json.dumps(facts, indent=2) + '\n')
    # Harness has already retired its own marked children. Retire only our copy.
    shutil.rmtree(scratch)
    print(json.dumps({key: facts[key] for key in ['tree','shape','direct_harness_exit','gate_invocations','author_status','proof_passed']}))
    return 0 if passed else 1

if __name__ == '__main__': raise SystemExit(main())
