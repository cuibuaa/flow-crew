#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release.sh prepare <version>
       scripts/release.sh squash <version> --message-file <file>
       scripts/release.sh publish <version> [--commit <commit>]  (default: HEAD)

Write a dated CHANGELOG.md section, then prepare on main. squash rebuilds
main as two commits on release-v<version> above origin/main in a temporary
worktree, proves both trees, and prints the branch. It does not push.
Fetch origin/main before squash; main must end with release: <version>.

Explicit operator step after reviewing the branch:
  git push --force-with-lease origin release-v<version>:tests
Wait for CI on tests, then publish that branch with --commit release-v<version>.
publish fetches main/tests, requires the latest tests push CI run to succeed,
and fast-forwards main before pushing the annotated tag and latest release.
Requires Bash, Node.js, Git and (for publish) authenticated gh.
USAGE
}

die() { echo "release: $*" >&2; exit 1; }

# Pure metadata operation: notes reads a changelog on stdin; prepare edits
# only the three version-bearing files after validating CHANGELOG.md.
release_metadata() {
  node - "$@" <<'NODE'
const fs = require('node:fs');
const [mode, version] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
  throw new Error('Expected a version without the v prefix');
}
const changelog = fs.readFileSync(mode === 'notes' ? 3 : 'CHANGELOG.md', 'utf8');
const headings = [...changelog.matchAll(/^## .*$/gm)];
const sections = headings.filter(h => h[0].startsWith(`## [${version}]`));
if (sections.length !== 1 || !new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] - \\d{4}-\\d{2}-\\d{2}$`).test(sections[0][0])) {
  throw new Error(`Require one dated CHANGELOG section: ## [${version}] - YYYY-MM-DD`);
}
const heading = sections[0];
const next = headings[headings.indexOf(heading) + 1];
const notes = changelog.slice(heading.index + heading[0].length + 1, next?.index ?? changelog.length);
if (mode === 'notes') { process.stdout.write(notes); process.exit(0); }
if (mode !== 'prepare') throw new Error('Unknown metadata operation');
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
manifest.version = lock.version = lock.packages[''].version = version;
const readme = fs.readFileSync('README.md', 'utf8');
const badge = /badge\/release-v[^"\s]+-2563eb\.svg/g;
const alt = /alt="FlowCrew v[^"\s]+"/g;
if ([...readme.matchAll(badge)].length !== 1 || [...readme.matchAll(alt)].length !== 1) {
  throw new Error('Require one README release badge and alt text');
}
fs.writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
fs.writeFileSync('README.md', readme.replace(badge, `badge/release-v${version}-2563eb.svg`)
  .replace(alt, `alt="FlowCrew v${version}"`));
NODE
} 3<&0

prepare() {
  release_metadata prepare "$version"
  local files=(CHANGELOG.md README.md package.json package-lock.json) file
  for file in "${files[@]}"; do
    git diff HEAD --quiet -- "$file" && die "$file must change for the release commit"
  done
  git commit --only -m "release: $version" -- "${files[@]}"
}

squash() (
  [[ $# == 2 && $1 == --message-file && -s $2 ]] || die 'squash requires --message-file <file>'
  local message base tip content tree content_tree branch scratch
  message=$(realpath "$2")
  base=$(git rev-parse origin/main)
  tip=$(git rev-parse main)
  [[ $(git show -s --format=%B "$tip") == "release: $version" ]] || die 'main must end with the release commit'
  git merge-base --is-ancestor "$base" "$tip" || die 'main does not descend from origin/main'
  [[ $(git rev-list --count "$base..$tip") -ge 2 ]] || die 'need unreleased content and a release commit'
  content=$(git rev-parse "$tip~1")
  tree=$(git rev-parse "$tip^{tree}")
  content_tree=$(git rev-parse "$content^{tree}")
  git show "$tip:CHANGELOG.md" | release_metadata notes "$version" >/dev/null
  branch="release-v$version"
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/flowcrew-release.XXXXXX")
  trap 'cd "$root"; git worktree remove --force "$scratch/checkout"; rmdir "$scratch"' EXIT
  git worktree add -b "$branch" "$scratch/checkout" "$base"
  cd "$scratch/checkout"
  [[ -z $(git ls-files -ci --exclude-standard) ]] || die 'tracked ignored files in origin/main'
  git read-tree -u --reset "$content_tree"
  [[ -z $(git ls-files -ci --exclude-standard) ]] || die 'tracked ignored files in content tree'
  git -c commit.gpgsign=false commit --allow-empty --cleanup=verbatim -F "$message"
  git read-tree -u --reset "$tree"
  [[ -z $(git ls-files -ci --exclude-standard) ]] || die 'tracked ignored files in release tree'
  git -c commit.gpgsign=false commit --allow-empty -m "release: $version"
  [[ $(git rev-parse HEAD^{tree}) == "$tree" ]] || die 'release tree differs from main'
  [[ $(git rev-parse HEAD~1^{tree}) == "$content_tree" ]] || die 'content tree differs from main~1'
  [[ $(git rev-list --count "$base..HEAD") == 2 ]] || die 'expected exactly two commits'
  echo "HEAD tree = main tree: $tree"
  echo "HEAD~1 tree = main~1 tree: $content_tree"
  cd "$root"
  echo "$branch"
)

publish() (
  local commit=HEAD ci notes remote_tags tag="v$version"
  if [[ $# != 0 ]]; then
    [[ $# == 2 && $1 == --commit ]] || die 'publish accepts only --commit <commit>'
    commit=$2
  fi
  commit=$(git rev-parse --verify "$commit^{commit}")
  git fetch origin +refs/heads/main:refs/remotes/origin/main +refs/heads/tests:refs/remotes/origin/tests
  [[ $commit == "$(git rev-parse origin/tests)" ]] || die 'commit must be origin/tests HEAD'
  [[ $(git show -s --format=%B "$commit") == "release: $version" ]] || die 'commit must be the release commit'
  git merge-base --is-ancestor origin/main "$commit" || die 'main push would not fast-forward'
  ci=$(gh api --method GET "repos/{owner}/{repo}/actions/workflows/ci.yml/runs?branch=tests&head_sha=$commit&event=push&per_page=1" \
    --jq '.workflow_runs[0] | [.head_sha, .head_branch, .status, .conclusion] | @tsv')
  [[ $ci == "$commit"$'\ttests\tcompleted\tsuccess' ]] || die 'latest CI push run on tests must conclude success for this commit'
  notes=$(mktemp "${TMPDIR:-/tmp}/flowcrew-release-notes.XXXXXX")
  trap 'rm -f "$notes"' EXIT
  git show "$commit:CHANGELOG.md" | release_metadata notes "$version" >"$notes"
  if git show-ref --verify --quiet "refs/tags/$tag"; then die "$tag already exists locally"; fi
  remote_tags=$(git ls-remote --tags origin "refs/tags/$tag")
  [[ -z $remote_tags ]] || die "$tag already exists on origin"
  git push origin "$commit:refs/heads/main"
  git -c tag.gpgsign=false tag -a "$tag" "$commit" -m "FlowCrew $version"
  git push origin "refs/tags/$tag"
  gh release create "$tag" --title "FlowCrew $version" --notes-file "$notes"
)

main() {
  if [[ ${1:-} == --help || $# == 0 ]]; then usage; return; fi
  [[ $# -ge 2 ]] || { usage >&2; exit 1; }
  local action=$1 version=$2 root
  shift 2
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]] || die 'expected a version without the v prefix'
  root=$(git rev-parse --show-toplevel)
  cd "$root"
  [[ -z $(git ls-files -ci --exclude-standard) ]] || die 'tracked files match ignore rules'
  case "$action" in
    prepare) [[ $# == 0 ]] || die 'prepare accepts no options'; prepare ;;
    squash) squash "$@" ;;
    publish) publish "$@" ;;
    *) usage >&2; exit 1 ;;
  esac
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
