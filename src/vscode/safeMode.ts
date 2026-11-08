/**
 * Persisted guard around the first workspace scan.
 *
 * The extension host kills (and, after three crashes in five minutes, disables)
 * every extension when a workspace is too large to index in the memory it has.
 * Nothing in the indexer can catch that: an out-of-memory kill is not an
 * exception. The only way to keep the host alive across restarts is to remember
 * - before parsing starts - that a scan is in flight, and to see that marker
 * still set on the next activation. A run that died mid-scan then starts in
 * safe mode: a small file budget, no database load, and no automatic database
 * work. Safe mode stays on until the user explicitly retries, so a workspace
 * that keeps crashing cannot take the host down three times in a row.
 */

export const SCAN_IN_PROGRESS_KEY = 'rtlens.scanInProgress';
export const SAFE_MODE_KEY = 'rtlens.safeMode';

/** Files indexed while safe mode is on; enough to navigate a small project. */
export const SAFE_MODE_MAX_FILES = 500;

/** Indexed-file count above which automatic database rebuilds are skipped. */
export const AUTO_DB_MAX_FILES = 4000;

/** A stored JSON database larger than this is not loaded into memory. */
export const MAX_DB_BYTES = 32 * 1024 * 1024;

/** The subset of `vscode.Memento` the guard needs; keeps this module vscode-free. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export class ScanGuard {
  private recoveringValue: boolean;
  private readonly crashed: boolean;

  constructor(
    private readonly state: MementoLike | undefined,
    private readonly log: (line: string) => void,
  ) {
    const safe = state?.get<boolean>(SAFE_MODE_KEY) === true;
    this.crashed = !safe && state?.get<boolean>(SCAN_IN_PROGRESS_KEY) === true;
    this.recoveringValue = safe || this.crashed;
  }

  /** True when the previous activation died before its scan + database load. */
  get safeMode(): boolean {
    return this.recoveringValue;
  }

  /**
   * Announce the crash risk and persist it. Awaited before the first parse, so
   * the marker reaches disk even if the host is killed mid-scan.
   */
  async begin(): Promise<void> {
    if (this.recoveringValue) {
      if (this.crashed) {
        await this.write(SCAN_IN_PROGRESS_KEY, false);
        await this.write(SAFE_MODE_KEY, true);
      }
      this.log(
        `[safe] previous indexing run did not finish; indexing at most ${SAFE_MODE_MAX_FILES} file(s) and skipping the databases`,
      );
      return;
    }
    await this.write(SCAN_IN_PROGRESS_KEY, true);
  }

  /** The scan and the database load finished, or failed in a handled way. */
  async finish(): Promise<void> {
    await this.write(SCAN_IN_PROGRESS_KEY, false);
    if (!this.recoveringValue) {
      await this.write(SAFE_MODE_KEY, false);
    }
  }

  /** A graceful shutdown is not a crash: drop the in-flight marker. */
  async abort(): Promise<void> {
    await this.write(SCAN_IN_PROGRESS_KEY, false);
  }

  /** Leave safe mode and allow a full scan again. */
  async reset(): Promise<void> {
    this.recoveringValue = false;
    await this.write(SCAN_IN_PROGRESS_KEY, false);
    await this.write(SAFE_MODE_KEY, false);
  }

  private async write(key: string, value: boolean): Promise<void> {
    if (!this.state) {
      return;
    }
    try {
      await this.state.update(key, value);
    } catch (e) {
      this.log(`[safe] could not persist ${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** True when the scan has reached the share of the V8 heap it may use. */
export function overHeapBudget(used: number, limit: number, fraction = 0.6): boolean {
  return limit > 0 && used > limit * fraction;
}

/** Automatic database rebuilds are skipped for huge or safe-mode workspaces. */
export function autoRefreshAllowed(files: number, safeMode: boolean): boolean {
  return !safeMode && files <= AUTO_DB_MAX_FILES;
}

/** A stored JSON database above the limit is not loaded into memory. */
export function oversizedDatabase(bytes: number, limit = MAX_DB_BYTES): boolean {
  return bytes > limit;
}
