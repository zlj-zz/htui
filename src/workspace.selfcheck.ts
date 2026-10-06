import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listFiles } from './workspace';

const home = await mkdtemp(path.join(os.tmpdir(), 'htui-ws-home-'));
const project = await mkdtemp(path.join(os.tmpdir(), 'htui-ws-proj-'));
process.env.HTUI_HOME = home;

try {
  await mkdir(path.join(project, 'api'), { recursive: true });
  await writeFile(path.join(project, 'api', 'users.http'), 'GET http://x/a');
  await writeFile(path.join(project, 'root.rest'), 'GET http://x/b');
  await mkdir(path.join(project, '.git'), { recursive: true });
  await writeFile(path.join(project, '.git', 'ignored.http'), 'GET http://x/c'); // dot dir skipped

  await mkdir(path.join(home, 'collections', 'crm'), { recursive: true });
  await writeFile(path.join(home, 'collections', 'crm', 'crm.http'), 'GET http://x/d');
  await writeFile(path.join(home, 'collections', 'crm', 'crm.local.http'), 'GET http://x/e');
  await writeFile(path.join(home, 'collections', 'legacy.http'), 'GET http://x/legacy'); // obsolete flat file

  await mkdir(path.join(project, '.htui', 'collections', 'loc'), { recursive: true });
  await writeFile(path.join(project, '.htui', 'collections', 'loc', 'loc.http'), 'GET http://x/f');

  const files = await listFiles(project);
  assert.deepEqual(
    files.map((f) => `${f.source}:${f.relPath}:${f.kind ?? '-'}`).sort(),
    [
      'collection:crm/crm.http:generated',
      'collection:crm/crm.local.http:local',
      'collection:loc/loc.http:generated', // project-local (--local) collections count too
      'project:api/users.http:-',
      'project:root.rest:-',
    ],
  );
} finally {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
  delete process.env.HTUI_HOME;
}

console.log('workspace.selfcheck: ok');
