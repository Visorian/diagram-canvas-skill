import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isRef, listVersions, readVersion } from "./versions.ts";

test("lists a diagram's versions from git and reads one", async () => {
  const root = await mkdtemp(join(tmpdir(), "diagram-canvas-skill-versions-"));
  const dir = join(root, "diagrams");
  // A repository of its own, apart from the user's git configuration.
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
  try {
    assert.deepEqual(await listVersions(root, "shop"), [], "no history outside a repository");
    await mkdir(dir);
    git("init", "-q");
    await writeFile(join(dir, "shop.txt"), "a: A\n");
    git("add", ".");
    git("commit", "-q", "-m", "First");
    await writeFile(join(dir, "shop.txt"), "a: A\nb: B\n");
    await writeFile(join(dir, "shop.layout.json"), '{ "b": [1, 2] }\n');
    git("add", ".");
    git("commit", "-q", "-m", "Second");
    await writeFile(join(dir, "shop.txt"), "a: A\nb: B\nc: C\n");

    const versions = await listVersions(dir, "shop");
    assert.deepEqual(
      versions.map(({ subject }) => subject),
      ["Second", "First"],
    );
    assert.deepEqual(await readVersion(dir, "shop", versions[1]!.ref), {
      ref: versions[1]!.ref,
      source: "a: A\n",
      layout: {},
    });
    assert.deepEqual(await readVersion(dir, "shop", "HEAD"), {
      ref: "HEAD",
      source: "a: A\nb: B\n",
      layout: { b: [1, 2] },
    });
    assert.equal((await readVersion(dir, "missing", "HEAD")).source, "", "not there yet");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts commits and HEAD, nothing git reads as an option or range", () => {
  for (const ref of ["HEAD", "HEAD~2", "1a2b3c4", "0123456789abcdef0123456789abcdef01234567"])
    assert.ok(isRef(ref), ref);
  for (const ref of ["--output=x", "main", "HEAD..1a2b", "HEAD^", "1a2b3c4:../x", ""])
    assert.ok(!isRef(ref), ref);
});
