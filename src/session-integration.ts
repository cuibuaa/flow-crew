import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function doctorSessionIntegration(frontend: 'claude' | 'codex', project: string, packageRoot: string, env: NodeJS.ProcessEnv): {
  name: string; status: 'ok' | 'warn'; message: string;
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
  for (const location of locations) {
    try {
      execFileSync(process.execPath, [checker, 'check', frontend, location.root, packageRoot], { cwd: project, env, encoding: 'utf8', timeout: 8_000, stdio: ['ignore', 'pipe', 'pipe'] });
      if (locations.length === 1) return { name, status: 'ok', message: 'shared Stop/SessionStart hooks and progress integration are current' };
    } catch (error) {
      const detail = (error as { stdout?: string }).stdout?.toString().trim() || 'missing or outdated session integration';
      issues.push(`${detail}. Repair: bash ${quote(join(packageRoot, 'skills', 'install.sh'))} --${frontend} --${location.scope}`);
    }
  }
  return issues.length ? { name, status: 'warn', message: issues.join('\n') }
    : { name, status: 'ok', message: 'session integrations are current' };
}
