import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Installer protocol fixture, not a real frontend or provider. */
export function fakeCodexHookRequest(message, codexHome, fixtureHome) {
  const home = codexHome || join(fixtureHome, '.codex');
  const config = join(home, 'config.toml');
  const readConfig = () => existsSync(config) ? readFileSync(config, 'utf8') : '';
  if (message.method === 'hooks/list') {
    const roots = [join(home, 'hooks.json'), ...(message.params.cwds || []).map(cwd => join(cwd, '.codex', 'hooks.json'))];
    const hooks = [];
    for (const path of roots) {
      if (!existsSync(path)) continue;
      const sourcePath = realpathSync(path);
      const source = JSON.parse(readFileSync(path, 'utf8'));
      for (const [event, groups] of Object.entries(source.hooks || {})) {
        const eventName = event === 'Stop' ? 'stop' : event === 'SessionStart' ? 'sessionStart' : event;
        groups.forEach((group, g) => group.hooks.forEach((handler, h) => {
          const currentHash = 'sha256:' + createHash('sha256').update(JSON.stringify(handler)).digest('hex');
          const key = `${sourcePath}:${event}:${g}:${h}`;
          const header = `[hooks.state.${JSON.stringify(key)}]`;
          const block = readConfig().split(header)[1]?.split(/^\[/m)[0] || '';
          const trustedHash = /^trusted_hash\s*=\s*"([^"]+)"/m.exec(block)?.[1];
          hooks.push({ key, sourcePath, eventName, command: handler.command, currentHash,
            enabled: !/^enabled\s*=\s*false\s*$/m.test(block),
            trustStatus: trustedHash === currentHash ? 'trusted' : trustedHash ? 'modified' : 'untrusted' });
        }));
      }
    }
    return { data: [{ cwd: process.cwd(), hooks }] };
  }
  if (message.method === 'config/batchWrite') {
    let text = readConfig();
    for (const edit of message.params.edits) {
      const match = /^hooks\.state\.("(?:[^"\\]|\\.)*")(?:\.(trusted_hash|enabled))?$/.exec(edit.keyPath);
      if (!match) throw new Error('Unexpected installer config edit');
      const header = `[hooks.state.${match[1]}]`;
      const key = match[2];
      const start = text.indexOf(header);
      let end = -1;
      let previous = '';
      if (start >= 0) {
        const next = text.slice(start + header.length).search(/^\[/m);
        end = next < 0 ? text.length : start + header.length + next;
        previous = text.slice(start + header.length, end);
        text = text.slice(0, start) + text.slice(end);
      }
      if (edit.value !== null) {
        previous = previous.replace(new RegExp(`^${key}\\s*=.*$`, 'm'), '').trim();
        text += `\n${header}\n${previous ? previous + '\n' : ''}${key} = ${JSON.stringify(edit.value)}\n`;
      }
    }
    const target = message.params.filePath || config;
    writeFileSync(target, text);
    return { status: 'ok', version: 'fixture-version', filePath: target };
  }
  return undefined;
}
