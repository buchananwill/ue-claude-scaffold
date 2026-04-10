import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveHooks } from "./hook-resolution.js";

describe("resolveHooks", () => {
  // --- System defaults only ---

  it("defaults buildIntercept=true when hasBuildScript=true, cppLint=false, jsLint=false", () => {
    const result = resolveHooks({ hasBuildScript: true });
    assert.equal(result.buildIntercept, true);
    assert.equal(result.cppLint, false);
    assert.equal(result.jsLint, false);
  });

  it("defaults buildIntercept=false when hasBuildScript=false", () => {
    const result = resolveHooks({ hasBuildScript: false });
    assert.equal(result.buildIntercept, false);
    assert.equal(result.cppLint, false);
    assert.equal(result.jsLint, false);
  });

  // --- Project overrides system ---

  it("project overrides buildIntercept", () => {
    const result = resolveHooks({
      hasBuildScript: true,
      projectHooks: { buildIntercept: false },
    });
    assert.equal(result.buildIntercept, false);
    assert.equal(result.cppLint, false);
  });

  it("project enables cppLint", () => {
    const result = resolveHooks({
      hasBuildScript: false,
      projectHooks: { cppLint: true },
    });
    assert.equal(result.buildIntercept, false);
    assert.equal(result.cppLint, true);
  });

  it("project enables jsLint", () => {
    const result = resolveHooks({
      hasBuildScript: false,
      projectHooks: { jsLint: true },
    });
    assert.equal(result.jsLint, true);
    assert.equal(result.cppLint, false);
  });

  // --- Team overrides project ---

  it("team overrides project buildIntercept", () => {
    const result = resolveHooks({
      hasBuildScript: true,
      projectHooks: { buildIntercept: false },
      teamHooks: { buildIntercept: true },
    });
    assert.equal(result.buildIntercept, true);
  });

  it("team overrides project cppLint", () => {
    const result = resolveHooks({
      hasBuildScript: false,
      projectHooks: { cppLint: true },
      teamHooks: { cppLint: false },
    });
    assert.equal(result.cppLint, false);
  });

  // --- Member overrides team ---

  it("member overrides team", () => {
    const result = resolveHooks({
      hasBuildScript: true,
      teamHooks: { buildIntercept: false, cppLint: true },
      memberHooks: { buildIntercept: true, cppLint: false },
    });
    assert.equal(result.buildIntercept, true);
    assert.equal(result.cppLint, false);
  });

  // --- CLI overrides everything ---

  it("CLI overrides all lower levels", () => {
    const result = resolveHooks({
      hasBuildScript: true,
      projectHooks: { buildIntercept: true, cppLint: true },
      teamHooks: { buildIntercept: true, cppLint: true },
      memberHooks: { buildIntercept: true, cppLint: true },
      cliOverride: { buildIntercept: false, cppLint: false },
    });
    assert.equal(result.buildIntercept, false);
    assert.equal(result.cppLint, false);
  });

  // --- Partial overrides ---

  it("team overrides buildIntercept but not cppLint", () => {
    const result = resolveHooks({
      hasBuildScript: true,
      projectHooks: { buildIntercept: false, cppLint: true },
      teamHooks: { buildIntercept: true },
    });
    assert.equal(result.buildIntercept, true);
    assert.equal(result.cppLint, true);
  });

  it("null values are treated as no-override", () => {
    const result = resolveHooks({
      hasBuildScript: true,
      projectHooks: { buildIntercept: false },
      teamHooks: { buildIntercept: null },
    });
    assert.equal(result.buildIntercept, false);
  });

  it("undefined values are treated as no-override", () => {
    const result = resolveHooks({
      hasBuildScript: true,
      projectHooks: { buildIntercept: false },
      teamHooks: { buildIntercept: undefined },
    });
    assert.equal(result.buildIntercept, false);
  });

  // --- All levels set simultaneously ---

  it("full cascade: CLI wins over all", () => {
    const result = resolveHooks({
      hasBuildScript: false,
      projectHooks: { buildIntercept: true, cppLint: true, jsLint: true },
      teamHooks: { buildIntercept: false, cppLint: false, jsLint: false },
      memberHooks: { buildIntercept: true, cppLint: true, jsLint: true },
      cliOverride: { buildIntercept: false, cppLint: false, jsLint: false },
    });
    assert.equal(result.buildIntercept, false);
    assert.equal(result.cppLint, false);
    assert.equal(result.jsLint, false);
  });

  it("full cascade without CLI: member wins", () => {
    const result = resolveHooks({
      hasBuildScript: false,
      projectHooks: { buildIntercept: true, cppLint: false, jsLint: true },
      teamHooks: { buildIntercept: false, cppLint: true, jsLint: false },
      memberHooks: { buildIntercept: true, cppLint: false, jsLint: true },
    });
    assert.equal(result.buildIntercept, true);
    assert.equal(result.cppLint, false);
    assert.equal(result.jsLint, true);
  });
});
