import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_CODE } from './exit-code.js';

export type SessionIntegrationResult = 'verified' | 'unavailable' | 'unfinished';

export function doctorSessionIntegration(frontend: 'claude' | 'codex', project: string, packageRoot: string, env: NodeJS.ProcessEnv): {
  name: string; status: 'ok' | 'warn'; result: SessionIntegrationResult; message: string;
} {
  const checker = join(packageRoot, 'skills', 'session-integration.mjs');
  const quote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`;
  const name = `${frontend === 'codex' ? 'Codex' : 'Claude Code'} session integration`;
  const globalRoot = frontend === 'codex' ? env.CODEX_HOME || join(env.HOME || '', '.codex')
    : env.CLAUDE_CONFIG_DIR || join(env.HOME || '', '.claude');
  const projectRoot = join(project, `.${frontend}`);
  const hasProject = existsSync(join(projectRoot, 'hooks', 'flowcrew-session.json'));
  const hasGlobal = existsSync(join(globalRoot, 'hooks', 'flowcrew-session.json'));
  const locations = [
    ...(hasGlobal || !hasProject ? [{ root: globalRoot, scope: 'global' }] : []),
    ...(hasProject ? [{ root: projectRoot, scope: 'project' }] : []),
  ];
  const issues: string[] = [];
  const pending: string[] = [];
  for (const location of locations) {
    try {
      execFileSync(process.execPath, [checker, 'check', frontend, location.root, packageRoot], { cwd: project, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (locations.length === 1) return { name, status: 'ok', result: 'verified', message: 'shared Stop/SessionStart hooks and progress integration are current' };
    } catch (error) {
      if ((error as { status?: number }).status === EXIT_CODE.inProgress) {
        pending.push((error as { stdout?: string }).stdout?.toString().trim() || 'session verification unfinished');
        continue;
      }
      const detail = (error as { stdout?: string }).stdout?.toString().trim() || 'missing or outdated session integration';
      issues.push(`${detail}. Repair: bash ${quote(join(packageRoot, 'skills', 'install.sh'))} --${frontend} --${location.scope}`);
    }
  }
  return issues.length ? { name, status: 'warn', result: 'unavailable', message: [...issues, ...pending].join('\n') }
    : pending.length ? { name, status: 'warn', result: 'unfinished', message: pending.join('\n') }
    : { name, status: 'ok', result: 'verified', message: 'session integrations are current' };
}
