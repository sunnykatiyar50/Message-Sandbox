#!/usr/bin/env node
// Cuts a release: bumps the version, commits, tags and pushes.
//
//   npm run release -- patch|minor|major|<x.y.z> [--dry-run]
//
// Passing the version package.json already has (the first release, for example) tags the current commit
// without a version-bump commit.
//
// Pushing the tag starts two GitHub Actions workflows:
//   docker.yml   tests, then publishes ghcr.io/<owner>/message-sandbox:<version> (and :X.Y, :X, :latest)
//   release.yml  creates the GitHub Release with notes and a docker-compose.yml pinned to the version
//
// Plain Node, so it behaves the same in PowerShell, Git Bash and Linux.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bump = args.find(a => !a.startsWith('--'));

function fail(message) {
    console.error(message);
    process.exit(1);
}

// Runs a command in the project root. On Windows npm is npm.cmd, which only runs through a shell, so
// npm is launched as `node <npm-cli.js>` (npm_execpath is set by `npm run`) to avoid the shell and its
// DEP0190 warning; the shell stays as a fallback when the script is run directly.
function run(command, commandArgs, { quiet = false } = {}) {
    const npmCli = command === 'npm' && process.env.npm_execpath;
    if (npmCli && /\.c?js$/.test(npmCli)) {
        commandArgs = [npmCli, ...commandArgs];
        command = process.execPath;
    }
    const result = spawnSync(command, commandArgs, {
        cwd: root,
        shell: process.platform === 'win32' && command === 'npm',
        encoding: 'utf8',
        stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });
    return result;
}

const out = (command, commandArgs) => {
    const result = run(command, commandArgs, { quiet: true });
    if (result.status !== 0) fail(`${command} ${commandArgs.join(' ')} failed:\n${result.stderr || result.stdout}`);
    return result.stdout.trim();
};

const readVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

if (!bump) fail('Usage: npm run release -- patch|minor|major|<x.y.z> [--dry-run]');
if (!/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) fail(`Unknown bump "${bump}": use patch, minor, major or x.y.z.`);

const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') fail(`Releases are cut from main (you are on ${branch}).`);
if (out('git', ['status', '--porcelain'])) fail('The working tree has uncommitted changes. Commit or stash them first.');

out('git', ['fetch', '--quiet', 'origin', 'main', '--tags']);
if (out('git', ['rev-parse', 'HEAD']) !== out('git', ['rev-parse', 'origin/main'])) {
    fail('main is not in sync with origin/main. Pull or push first.');
}

console.log('Running tests...');
if (run('npm', ['test', '--silent']).status !== 0) fail('Tests failed; nothing was released.');

// Let npm work out the new version (and validate the argument), then undo the file changes until we're sure
const current = readVersion();
const tagOnly = bump === current;
if (!tagOnly && run('npm', ['version', bump, '--no-git-tag-version', '--silent'], { quiet: true }).status !== 0) {
    fail(`npm could not bump ${current} by "${bump}" (an exact version must be higher than the current one).`);
}
const next = readVersion();
const tag = `v${next}`;
const restoreFiles = () => run('git', ['checkout', '--', 'package.json', 'package-lock.json'], { quiet: true });

if (out('git', ['tag', '--list', tag])) {
    restoreFiles();
    fail(`Tag ${tag} already exists.`);
}

console.log(tagOnly ? `Release: ${next} as it is (tag ${tag})` : `Release: ${current} -> ${next} (tag ${tag})`);
if (dryRun) {
    restoreFiles();
    const lastTag = run('git', ['describe', '--tags', '--abbrev=0'], { quiet: true });
    const range = lastTag.status === 0 ? `${lastTag.stdout.trim()}..HEAD` : 'HEAD';
    console.log('Dry run: nothing changed. Commits in this release:');
    console.log(out('git', ['log', '--oneline', range]));
    process.exit(0);
}

if (!tagOnly) {
    out('git', ['add', 'package.json', 'package-lock.json']);
    out('git', ['commit', '-q', '-m', `Release ${tag}`]);
}
out('git', ['tag', '-a', tag, '-m', `Release ${tag}`]);
if (run('git', ['push', 'origin', 'main', tag]).status !== 0) {
    fail(`Push failed. The commit and tag ${tag} exist locally; fix the problem and run: git push origin main ${tag}`);
}

console.log(`Pushed ${tag}. Watch the workflows: gh run list --limit 3`);
