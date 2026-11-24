import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : extname(path) === '.md' ? [path] : [];
  });
}
// Bounded Markdown syntax, not a prose classifier. These docs use ATX headings,
// inline/reference destinations and HTML assets. Code examples do not create links.
function prose(text: string): string {
  let fence: string | undefined;
  return text.split('\n').map(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (fence === marker[1][0]) fence = undefined;
      return '';
    }
    return fence ? '' : line;
  }).join('\n');
}
function anchors(text: string): Set<string> {
  const seen = new Map<string, number>();
  return new Set([...prose(text).matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)].map(([, heading]) => {
    const slug = heading.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    return count ? `${slug}-${count}` : slug;
  }));
}
function destinations(text: string): string[] {
  const content = prose(text);
  return [
    ...[...content.matchAll(/\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)].map(match => match[1] ?? match[2]),
    ...[...content.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>]+)>|(\S+))/gm)].map(match => match[1] ?? match[2]),
    ...[...content.matchAll(/\b(?:href|src)="([^"]+)"/g)].map(match => match[1]),
  ];
}

it('resolves relative links and heading anchors in README, guides, examples and skill sources', () => {
  const sources = [join(root, 'README.md'), ...markdownFiles(join(root, 'guide')),
    ...markdownFiles(join(root, 'examples')), ...['ship', 'fc-status'].map(name => join(root, 'skills', `${name}.md`))];
  expect(destinations(readFileSync(sources[0], 'utf8')).filter(href => href.includes('#')).length).toBeGreaterThan(0);
  const failures: string[] = [];
  for (const file of sources) for (const href of destinations(readFileSync(file, 'utf8'))) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
    const [path, fragment] = href.split('#');
    const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
    const label = `${relative(root, file)}: ${href}`;
    if (!target.startsWith(root + sep) || !existsSync(target)) failures.push(label + ' (missing or outside repository)');
    else if (fragment && (!statSync(target).isFile() || !anchors(readFileSync(target, 'utf8')).has(decodeURIComponent(fragment))))
      failures.push(label + ' (missing heading)');
  }
  expect(failures).toEqual([]);
});

describe('release metadata cannot drift', () => {
  // The README badge and package.json are two statements of the same fact, and
  // nothing previously reconciled them: v0.5.0 shipped with the badge already
  // one release stale. A version bump that forgets the badge now fails here
  // rather than being noticed by a reader months later.
  it('states the same version in package.json, the README badge, and its alt text', () => {
    const version = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf-8'),
    ).version as string;
    const readme = readFileSync(join(root, 'README.md'), 'utf-8');

    expect(readme).toContain(`badge/release-v${version}-`);
    expect(readme).toContain(`alt="FlowCrew v${version}"`);
  });

  it('has a dated changelog section for the version being shipped', () => {
    const version = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf-8'),
    ).version as string;
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf-8');

    expect(changelog).toMatch(
      new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'),
    );
  });
});
