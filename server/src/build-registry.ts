/**
 * In-memory registry of build/test child processes currently running on the host.
 *
 * A build's liveness is host-local, ephemeral truth that this server process
 * already owns: it holds the ChildProcess handle and is awaiting its exit for the
 * whole duration of the build. So liveness lives here, in memory — not in the DB.
 * The DB lock row stays a pure coordination token (holder, acquiredAt, priority);
 * whether the holder's build is actually alive is answered locally by the same
 * process that spawned it.
 *
 * Keyed by build_history id. Entries exist only between spawn and exit. A server
 * restart drops the registry — after which any orphaned build is reaped by the
 * spawn timeout it inherited, and the lock frees via idle staleness.
 */
import type { ChildProcess } from "node:child_process";
import { killTree } from "./process-utils.js";

const active = new Map<number, ChildProcess>();

export function registerBuild(histId: number, child: ChildProcess): void {
  active.set(histId, child);
}

export function unregisterBuild(histId: number): void {
  active.delete(histId);
}

/**
 * True if any build/test child is currently running on this host. The sweeper
 * uses this to hold the UBT lock for as long as a build genuinely runs — however
 * long that is — instead of expiring it on a wall-clock timeout.
 */
export function hasLiveBuild(): boolean {
  for (const child of active.values()) {
    if (child.exitCode === null && !child.killed) {
      return true;
    }
  }
  return false;
}

/**
 * Tree-kill every tracked build child. Returns the PIDs that were signalled.
 * Used by the operator kill endpoint to terminate a runaway build.
 */
export function killAllBuilds(): number[] {
  const killed: number[] = [];
  for (const child of active.values()) {
    if (child.pid != null) {
      killed.push(child.pid);
      killTree(child.pid);
    }
  }
  return killed;
}
