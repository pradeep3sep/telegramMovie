import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
for (const dir of ['src', 'scripts', 'test']) {
  for (const file of await readdir(dir)) {
    if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', dir + '/' + file], { stdio: 'inherit' });
  }
}
for (const file of await readdir('.github/workflows')) {
  const workflow = parse(await readFile('.github/workflows/' + file, 'utf8'));
  if (!workflow.name || !workflow.on || !workflow.jobs) throw new Error('Invalid workflow: ' + file);
}
console.log('JavaScript syntax and workflow YAML checks passed.');
