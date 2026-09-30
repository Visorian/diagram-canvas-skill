// Earlier versions of a diagram, from the git history of its folder.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toDiagramFiles, type Version } from "../src/diagram/format.ts";

const run = promisify(execFile);

// A commit hash, or HEAD with up to a few thousand steps back. Nothing that git could read as an
// option or a range.
export const isRef = (value: string) => /^(?:[0-9a-f]{4,40}|HEAD(?:~\d{1,4})?)$/.test(value);

// Commits that changed the diagram's model, newest first; none outside a git repository.
export async function listVersions(dir: string, name: string): Promise<Version[]> {
  try {
    const { stdout } = await run(
      "git",
      ["log", "-n", "50", "--format=%H%x1f%cI%x1f%s", "--", `${name}.txt`],
      { cwd: dir },
    );
    return stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [ref = "", date = "", subject = ""] = line.split("\x1f");
        return { ref, date, subject };
      });
  } catch {
    return [];
  }
}

// The diagram's model and pinned positions as of `ref`; empty where it didn't exist yet.
export async function readVersion(dir: string, name: string, ref: string) {
  const show = async (suffix: string) => {
    try {
      const { stdout } = await run("git", ["show", `${ref}:./${name}${suffix}`], {
        cwd: dir,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return undefined;
    }
  };
  const [source, layout] = await Promise.all([show(".txt"), show(".layout.json")]);
  const files = toDiagramFiles(name, { ".txt": source, ".layout.json": layout });
  return { ref, source: files.source, layout: files.layout };
}
