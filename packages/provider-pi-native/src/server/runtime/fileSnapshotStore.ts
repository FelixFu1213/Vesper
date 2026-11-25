import {
  computeFileTag,
  pathBasename,
  type FileAnchorStore,
  type FileSnapshot,
} from "./fileAnchorTypes.ts";

export const MAX_PATHS_PER_SESSION = 64;
export const MAX_VERSIONS_PER_PATH = 4;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;
export const MAX_RETAINED_FILE_BYTES = 2 * 1024 * 1024;

interface RetainedSnapshot {
  readonly text: string;
  readonly tag: string;
  seenLines: Set<number> | null;
  readonly retained: boolean;
}

interface PathHistory {
  /** Newest first. */
  readonly versions: Array<RetainedSnapshot>;
}

const unionSeen = (
  existing: Set<number> | null,
  incoming: ReadonlySet<number> | null,
): Set<number> | null => {
  if (incoming === null) return existing;
  if (existing === null) return new Set(incoming);
  for (const line of incoming) existing.add(line);
  return existing;
};

/**
 * Per-session LRU snapshot store (spec 18 §4). Bounds are contract: eviction only
 * ever costs recovery and provenance, never a wrong write.
 */
export class FileSnapshotStore implements FileAnchorStore {
  readonly #paths = new Map<string, PathHistory>();
  readonly #lru: Array<string> = [];
  #retainedBytes = 0;

  record(filePath: string, text: string, seenLines: ReadonlySet<number> | null): string {
    const tag = computeFileTag(text);
    this.#touch(filePath);
    const history = this.#history(filePath);
    const existing = history.versions.findIndex(
      (snapshot) => snapshot.tag === tag && snapshot.text === text,
    );
    if (existing !== -1) {
      const [promoted] = history.versions.splice(existing, 1);
      if (promoted !== undefined) {
        promoted.seenLines = unionSeen(promoted.seenLines, seenLines);
        history.versions.unshift(promoted);
      }
      return tag;
    }

    const retained = text.length <= MAX_RETAINED_FILE_BYTES;
    history.versions.unshift({
      text: retained ? text : "",
      tag,
      seenLines: seenLines === null ? null : new Set(seenLines),
      retained,
    });
    if (retained) this.#retainedBytes += text.length;
    while (history.versions.length > MAX_VERSIONS_PER_PATH) {
      this.#drop(history.versions.pop());
    }
    this.#evictOverBounds();
    return tag;
  }

  latestMatchingText(filePath: string, text: string): FileSnapshot | undefined {
    return this.#paths
      .get(filePath)
      ?.versions.find((snapshot) => snapshot.retained && snapshot.text === text);
  }

  lookupTag(filePath: string, tag: string): FileSnapshot | undefined {
    const wanted = tag.toUpperCase();
    return this.#paths.get(filePath)?.versions.find((snapshot) => snapshot.tag === wanted);
  }

  latestTag(filePath: string): string | undefined {
    return this.#paths.get(filePath)?.versions[0]?.tag;
  }

  mergeSeenLines(filePath: string, text: string, lines: Iterable<number>): void {
    const snapshot = this.#paths
      .get(filePath)
      ?.versions.find((candidate) => candidate.retained && candidate.text === text);
    if (snapshot === undefined) return;
    snapshot.seenLines = unionSeen(snapshot.seenLines, new Set(lines));
  }

  invalidatePath(filePath: string): void {
    const history = this.#paths.get(filePath);
    if (history === undefined) return;
    for (const snapshot of history.versions) this.#drop(snapshot);
    this.#paths.delete(filePath);
    const at = this.#lru.indexOf(filePath);
    if (at !== -1) this.#lru.splice(at, 1);
  }

  findUniqueBasenameTag(basename: string, tag: string, excludePath: string): string | undefined {
    const wanted = tag.toUpperCase();
    const hits: Array<string> = [];
    for (const [filePath, history] of this.#paths) {
      if (filePath === excludePath) continue;
      if (pathBasename(filePath) !== basename) continue;
      if (!history.versions.some((snapshot) => snapshot.tag === wanted)) continue;
      hits.push(filePath);
    }
    return hits.length === 1 ? hits[0] : undefined;
  }

  #history(filePath: string): PathHistory {
    const existing = this.#paths.get(filePath);
    if (existing !== undefined) return existing;
    const created: PathHistory = { versions: [] };
    this.#paths.set(filePath, created);
    return created;
  }

  #touch(filePath: string): void {
    const at = this.#lru.indexOf(filePath);
    if (at !== -1) this.#lru.splice(at, 1);
    this.#lru.push(filePath);
  }

  #drop(snapshot: RetainedSnapshot | undefined): void {
    if (snapshot?.retained === true) this.#retainedBytes -= snapshot.text.length;
  }

  #evictOverBounds(): void {
    while (this.#paths.size > MAX_PATHS_PER_SESSION || this.#retainedBytes > MAX_RETAINED_BYTES) {
      const cold = this.#lru.shift();
      if (cold === undefined) return;
      const history = this.#paths.get(cold);
      if (history === undefined) continue;
      for (const snapshot of history.versions) this.#drop(snapshot);
      this.#paths.delete(cold);
    }
  }
}
