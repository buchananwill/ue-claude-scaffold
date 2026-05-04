import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { applyScaffoldDatabaseUrl } from "./db-env.js";

describe("applyScaffoldDatabaseUrl", () => {
  let originalScaffold: string | undefined;
  let originalDatabase: string | undefined;

  beforeEach(() => {
    originalScaffold = process.env.SCAFFOLD_DATABASE_URL;
    originalDatabase = process.env.DATABASE_URL;
    delete process.env.SCAFFOLD_DATABASE_URL;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalScaffold === undefined)
      delete process.env.SCAFFOLD_DATABASE_URL;
    else process.env.SCAFFOLD_DATABASE_URL = originalScaffold;
    if (originalDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabase;
  });

  it("copies SCAFFOLD_DATABASE_URL onto DATABASE_URL, overriding any inherited value", () => {
    process.env.SCAFFOLD_DATABASE_URL = "postgresql://scaffold/db";
    process.env.DATABASE_URL = "postgresql://hijacker/wrong";

    const result = applyScaffoldDatabaseUrl();

    assert.equal(process.env.DATABASE_URL, "postgresql://scaffold/db");
    assert.equal(result.backendHint, "postgres");
  });

  it("deletes inherited DATABASE_URL when SCAFFOLD_DATABASE_URL is unset", () => {
    process.env.DATABASE_URL = "postgresql://hijacker/wrong";

    const result = applyScaffoldDatabaseUrl();

    assert.equal(process.env.DATABASE_URL, undefined);
    assert.equal(result.backendHint, "pglite");
  });

  it("returns pglite hint when neither env var is set", () => {
    const result = applyScaffoldDatabaseUrl();

    assert.equal(process.env.DATABASE_URL, undefined);
    assert.equal(result.backendHint, "pglite");
  });
});
