// Claude Code SessionStart hook: a new git worktree has no node_modules, so install each
// app's locked packages before the agent starts, letting it run tests and builds at once.
// It does nothing where node_modules already exists. It never fails the session: on an
// error it tells the agent to run `npm ci` itself.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const report = [];

for (const app of ['backend', 'frontend']) {
  const dir = join(root, app);
  if (!existsSync(join(dir, 'package-lock.json')) || existsSync(join(dir, 'node_modules'))) {
    continue;
  }
  // stdout is added to the agent's context, so npm's own output goes to stderr only.
  const result = spawnSync('npm ci --no-audit --no-fund', {
    cwd: dir,
    shell: true,
    stdio: ['ignore', process.stderr, process.stderr],
  });
  report.push(
    result.status === 0
      ? `Installed packages in ${app}/ (npm ci).`
      : `npm ci failed in ${app}/: run it yourself before testing.`,
  );
}

if (report.length) console.log(report.join('\n'));
