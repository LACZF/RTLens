/**
 * The persisted half of the relation database: where it lives, that a refresh
 * writes it, and that the status-bar service reads it back.
 *
 * The pure merge is covered by `relations.test.ts`; this one drives the real
 * `DatabaseService` against a throwaway workspace folder so the file path under
 * `.vscode/rtlens/` and the incremental re-read are exercised for real.
 */
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Module } from 'node:module';

import { documentFor, vscode } from './vscodeStub';

const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : originalLoad(request, ...rest);
};

const TEMP = path.join('/tmp/opencode', 'rtlens-db-test');
const CHILD = path.join(TEMP, 'child.v');
const PARENT = path.join(TEMP, 'parent.v');
const CHILD_SRC = 'module leaf (input wire a, output wire s); assign s = a; endmodule\n';
const PARENT_SRC = 'module top (input wire x, output wire y); leaf u (.a (x), .s (y)); endmodule\n';

interface Log {
  appendLine(line: string): void;
}

const DB_FILE_ON_DISK = path.join(TEMP, '.vscode', 'rtlens', 'relations.json');

const originalConfig = vscode.workspace.getConfiguration;

async function setup(settings: Record<string, unknown> = {}) {
  fs.rmSync(TEMP, { recursive: true, force: true });
  fs.mkdirSync(TEMP, { recursive: true });
  fs.writeFileSync(CHILD, CHILD_SRC);
  fs.writeFileSync(PARENT, PARENT_SRC);
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: vscode.Uri.file(TEMP), name: 'db', index: 0 },
  ];
  // `IndexService` snapshots the configuration in its constructor, so the
  // override has to be in place before the service is built.
  (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback),
  });

  const { IndexService } = await import('../vscode/indexService');
  const mod = await import('../vscode/database');
  const log: Log = { appendLine() {} };
  const svc = new IndexService(vscode.window.createOutputChannel('test') as never);
  svc.index.addFile(CHILD, CHILD_SRC);
  svc.index.addFile(PARENT, PARENT_SRC);
  const db = new mod.DatabaseService(svc as never, log as never);
  return { mod, svc, db };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

after(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  vscode.workspace.getConfiguration = originalConfig;
});

test('database: a refresh writes relations under .vscode/rtlens', async () => {
  const { db } = await setup();
  const summary = await db.refresh('full');
  db.dispose();

  assert.equal(summary.folders, 1);
  assert.equal(summary.files, 2, 'both indexed files are recorded');
  assert.equal(summary.changed, 2);

  const file = path.join(TEMP, '.vscode', 'rtlens', 'relations.json');
  assert.ok(fs.existsSync(file), 'the database file is on disk');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(parsed.files).sort(), ['child.v', 'parent.v']);
  assert.deepEqual(parsed.files['parent.v'].modules[0].connections[0].signals, ['x']);

  const stats = db.stats();
  assert.equal(stats.modules, 2);
  assert.equal(stats.connections, 2);
});

test('database: a later service loads what the first one wrote', async () => {
  const { mod, svc } = await setup();
  const first = new mod.DatabaseService(svc as never, { appendLine() {} } as never);
  await first.refresh('full');
  first.dispose();

  const second = new mod.DatabaseService(svc as never, { appendLine() {} } as never);
  await second.load();
  assert.equal(second.stats().modules, 2, 'the on-disk database is picked up on load');
  second.dispose();
});

test('database: incremental reuses untouched files after an edit', async () => {
  const { db, svc } = await setup();
  await db.refresh('full');

  const changedParent = PARENT_SRC.replace('u ', 'u2 ');
  fs.writeFileSync(PARENT, changedParent);
  svc.index.addFile(PARENT, changedParent);

  const summary = await db.refresh('incremental');
  db.dispose();
  assert.deepEqual(summary.changed, 1);
  assert.equal(summary.reused, 1);
  assert.equal(summary.removed, 0);
});

test('database: pickRefreshMode returns the chosen mode', async () => {
  const { mod } = await setup();
  (vscode as unknown as { __quickPick?: unknown }).__quickPick = (items: { mode: string }[]) => items[0];
  const mode = await mod.pickRefreshMode();
  assert.equal(mode, 'incremental');
  (vscode as unknown as { __quickPick?: unknown }).__quickPick = undefined;
});

test('database: auto-update writes the database after an index change', async () => {
  const { db, svc } = await setup();
  await db.load();
  assert.ok(!fs.existsSync(DB_FILE_ON_DISK), 'load() alone does not write');

  // A watched document that is not yet synced ingests and fires onDidChange.
  svc.watchDocument(documentFor(PARENT, PARENT_SRC) as never);
  await wait(700);
  db.dispose();

  assert.ok(fs.existsSync(DB_FILE_ON_DISK), 'an index change auto-refreshes the database');
  assert.equal(db.stats().modules, 2);
});

test('database: the activation scan alone does not write the database', async () => {
  const { db, svc } = await setup();
  // Fire the index event before `load()` - the case the activation scan hits.
  // Wait past the debounce: otherwise the assertion would pass merely because
  // the timer has not fired yet, whether or not the event was ignored.
  svc.watchDocument(documentFor(PARENT, PARENT_SRC) as never);
  await wait(700);
  assert.ok(!fs.existsSync(DB_FILE_ON_DISK), 'auto-update starts only after load()');
  db.dispose();
});

// The fingerprint decides both "is the database still fresh" and "which files
// have to be recomputed", so it has to describe what the index holds. Reading
// every file back off disk costs a syscall per file - a few thousand files is
// the difference between an instant click and a frozen extension host - and can
// disagree with the index the database is built from (an unsaved buffer, or a
// change the watcher has not reported yet).
test('database: the fingerprint follows the indexed text, not bytes that moved behind it', async () => {
  const { mod, svc } = await setup();
  const inputs = () => mod.collectInputs(svc, vscode.Uri.file(TEMP));
  const hashOf = (file: string) => inputs().find((i) => i.file === file)!.hash;

  const before = hashOf(PARENT);
  await svc.upsertPublic(PARENT);
  // The file changes on disk without the watcher ever reporting it.
  fs.writeFileSync(PARENT, PARENT_SRC.replace('u ', 'u3 '));

  assert.equal(
    hashOf(PARENT),
    before,
    'the hash follows what the index holds, so an unnoticed disk change does not move the fingerprint',
  );
  assert.notEqual(hashOf(CHILD), undefined, 'the untouched sibling is still collected');
});

test('database: auto-update is skipped when disabled, but a file-set change forces it', async () => {
  const { db, svc } = await setup({ autoUpdateDatabase: false });
  db.load();

  // Wait past the debounce so a would-be auto refresh has had time to fire.
  svc.watchDocument(documentFor(PARENT, PARENT_SRC) as never);
  await wait(700);
  assert.ok(!fs.existsSync(DB_FILE_ON_DISK), 'a disabled auto-update leaves disk alone');

  // The scan-set configuration exception goes through the same scheduler.
  db.scheduleAutoRefresh(0);
  await wait(100);
  db.dispose();
  assert.ok(fs.existsSync(DB_FILE_ON_DISK), 'an explicit schedule still rebuilds it');
});

// The status-bar button is the only acknowledgement the click gets until the
// rebuild finishes, so it has to flip to a spinner synchronously on entry and
// settle back to the resting label through the `finally` path - a refresh that
// throws must not leave the spinner stuck either.
test('database: the status bar announces a running refresh and settles afterwards', async () => {
  const { db } = await setup();
  const bars = (vscode as unknown as { __statusBars: { text: string }[] }).__statusBars;
  const bar = bars[bars.length - 1];
  assert.match(bar.text, /build DB/, 'the resting label before the click');

  const pending = db.refresh('full');
  assert.match(bar.text, /sync~spin/, 'the button spins while the refresh runs');

  await pending;
  assert.doesNotMatch(bar.text, /sync~spin/, 'the spinner is cleared once the refresh finishes');
  assert.match(bar.text, /RTLens DB/, 'the button shows the built database');
  db.dispose();
});
