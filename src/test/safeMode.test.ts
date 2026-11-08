/**
 * The persisted scan guard: a scan marker left behind by a crashed host must
 * turn the next activation into safe mode, and only an explicit reset may
 * leave it again.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  AUTO_DB_MAX_FILES,
  MAX_DB_BYTES,
  SAFE_MODE_KEY,
  SAFE_MODE_MAX_FILES,
  SCAN_IN_PROGRESS_KEY,
  ScanGuard,
  autoRefreshAllowed,
  overHeapBudget,
  oversizedDatabase,
} from '../vscode/safeMode';

class FakeState {
  readonly values = new Map<string, unknown>();
  readonly writes: string[] = [];

  constructor(initial: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.values.set(key, value);
    }
  }

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    this.writes.push(key);
  }
}

test('safe mode: a clean workspace scans and clears the marker', async () => {
  const state = new FakeState();
  const guard = new ScanGuard(state, () => {});
  assert.equal(guard.safeMode, false);

  await guard.begin();
  assert.equal(state.get(SCAN_IN_PROGRESS_KEY), true);

  await guard.finish();
  assert.equal(state.get(SCAN_IN_PROGRESS_KEY), false);
  assert.equal(state.get(SAFE_MODE_KEY), false);
});

test('safe mode: a marker left by a crash turns the next activation safe', async () => {
  const state = new FakeState({ [SCAN_IN_PROGRESS_KEY]: true });
  const guard = new ScanGuard(state, () => {});
  assert.equal(guard.safeMode, true);

  await guard.begin();
  assert.equal(state.get(SCAN_IN_PROGRESS_KEY), false);
  assert.equal(state.get(SAFE_MODE_KEY), true);

  await guard.finish();
  assert.equal(state.get(SAFE_MODE_KEY), true, 'safe mode survives the scan');
});

test('safe mode: a persisted safe mode stays on across activations until reset', async () => {
  const state = new FakeState({ [SAFE_MODE_KEY]: true });
  const guard = new ScanGuard(state, () => {});
  assert.equal(guard.safeMode, true);

  await guard.begin();
  await guard.finish();
  assert.equal(state.get(SAFE_MODE_KEY), true);

  await guard.reset();
  assert.equal(guard.safeMode, false);
  assert.equal(state.get(SAFE_MODE_KEY), false);
  assert.equal(state.get(SCAN_IN_PROGRESS_KEY), false);
});

test('safe mode: a graceful shutdown drops the marker but keeps safe mode', async () => {
  const state = new FakeState({ [SCAN_IN_PROGRESS_KEY]: true });
  const guard = new ScanGuard(state, () => {});
  await guard.abort();
  assert.equal(state.get(SCAN_IN_PROGRESS_KEY), false);
  assert.equal(guard.safeMode, true);
});

test('safe mode: a missing memento is tolerated', async () => {
  const guard = new ScanGuard(undefined, () => {});
  assert.equal(guard.safeMode, false);
  await guard.begin();
  await guard.finish();
  await guard.abort();
  await guard.reset();
});

test('safe mode: the heap, file-count and database-size limits', () => {
  assert.equal(SAFE_MODE_MAX_FILES, 500);
  assert.equal(AUTO_DB_MAX_FILES, 4000);
  assert.equal(MAX_DB_BYTES, 32 * 1024 * 1024);

  assert.equal(overHeapBudget(60, 100), false);
  assert.equal(overHeapBudget(61, 100), true);
  assert.equal(overHeapBudget(1, 0), false);

  assert.equal(autoRefreshAllowed(SAFE_MODE_MAX_FILES, false), true);
  assert.equal(autoRefreshAllowed(AUTO_DB_MAX_FILES, false), true);
  assert.equal(autoRefreshAllowed(AUTO_DB_MAX_FILES + 1, false), false);
  assert.equal(autoRefreshAllowed(1, true), false);

  assert.equal(oversizedDatabase(MAX_DB_BYTES), false);
  assert.equal(oversizedDatabase(MAX_DB_BYTES + 1), true);
  assert.equal(oversizedDatabase(5, 4), true);
});
