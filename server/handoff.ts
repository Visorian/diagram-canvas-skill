// The canvas hands a diagram over by writing `<name>.handoff`, with the user's message if any.
import { watch } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { partNames } from "../src/diagram/format.ts";

export interface Handoff {
  name: string;
  text: string;
}

// Takes the pending handoffs, so the canvas sees they were picked up. A file that is already gone
// or still empty is skipped: a handoff always ends with a newline, and writing it wakes us again.
async function takeHandoffs(dir: string) {
  const handoffs = await Promise.all(
    partNames(await readdir(dir), ".handoff").map(async (name) => {
      const path = join(dir, `${name}.handoff`);
      const content = await readFile(path, "utf8").catch(() => "");
      if (content === "") return undefined;
      await rm(path, { force: true });
      return { name, text: content.trim() };
    }),
  );
  return handoffs.filter((handoff): handoff is Handoff => handoff !== undefined);
}

// Resolves with the handoffs as soon as there are any, including ones sent before the call.
export async function waitForHandoffs(dir: string) {
  await mkdir(dir, { recursive: true });
  return new Promise<Handoff[]>((resolve, reject) => {
    // One look at a time; a change during a look triggers another one.
    let looking = false;
    let changed = false;
    const look = () => {
      if (looking) {
        changed = true;
        return;
      }
      looking = true;
      changed = false;
      takeHandoffs(dir).then(
        (handoffs) => {
          looking = false;
          if (handoffs.length > 0) {
            watcher.close();
            resolve(handoffs);
          } else if (changed) look();
        },
        (error: unknown) => {
          watcher.close();
          reject(error);
        },
      );
    };
    // Watch before the first look, so a handoff written in between still wakes it.
    const watcher = watch(dir, look);
    look();
  });
}
