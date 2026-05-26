/**
 * Host-process tree-kill helper for the UBT build runner.
 *
 * The coordination server spawns the real UE build on the host, and a build is a
 * deep process tree (python/bash → UnrealBuildTool (dotnet) → cl.exe/link.exe).
 * Signalling only the direct child orphans the compilers, which keep running and
 * holding the toolchain. This reaps the whole tree from a given PID.
 */
import { spawn } from "node:child_process";

/**
 * Kill a process and its entire descendant tree.
 *
 * On Windows `taskkill /T /F` walks the tree from the given PID; on POSIX we fall
 * back to a direct SIGKILL. Best-effort and non-throwing — a missing target is
 * not an error.
 */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        detached: true,
      }).unref();
    } catch {
      /* best effort */
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* best effort */
    }
  }
}
