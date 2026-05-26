import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  registerBuild,
  unregisterBuild,
  hasLiveBuild,
  killAllBuilds,
} from "./build-registry.js";

/** A stand-in child that reports as alive without spawning a real process. */
function fakeLiveChild(pid?: number): ChildProcess {
  return { exitCode: null, killed: false, pid } as unknown as ChildProcess;
}

describe("build-registry", () => {
  afterEach(() => {
    // Drain any leftover registrations so tests don't bleed into each other.
    killAllBuilds();
    for (let i = 0; i < 1000; i++) unregisterBuild(i);
  });

  it("hasLiveBuild is false when nothing is registered", () => {
    assert.equal(hasLiveBuild(), false);
  });

  it("hasLiveBuild becomes true after a build is registered", () => {
    registerBuild(1, fakeLiveChild());
    assert.equal(hasLiveBuild(), true);
    unregisterBuild(1);
    assert.equal(hasLiveBuild(), false);
  });

  it("hasLiveBuild ignores children that have already exited", () => {
    const exited = {
      exitCode: 0,
      killed: true,
      pid: 123,
    } as unknown as ChildProcess;
    registerBuild(2, exited);
    assert.equal(hasLiveBuild(), false);
    unregisterBuild(2);
  });

  it("killAllBuilds tree-kills a real child and returns its pid", async () => {
    // A long-lived child we can prove gets reaped.
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      {
        stdio: "ignore",
      },
    );
    await new Promise<void>((resolve) => child.on("spawn", () => resolve()));
    registerBuild(3, child);

    const exitPromise = new Promise<void>((resolve) =>
      child.on("exit", () => resolve()),
    );
    const killed = killAllBuilds();
    assert.ok(child.pid != null);
    assert.deepEqual(killed, [child.pid]);

    await exitPromise; // resolves only if the process was actually terminated
    unregisterBuild(3);
  });
});
