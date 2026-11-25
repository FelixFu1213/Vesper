// @effect-diagnostics nodeBuiltinImport:off -- Canonicalizing workspace roots is a filesystem boundary outside Effect.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export type SandboxAccess = "read" | "write";

export type SandboxClassification = "workspace" | "scratch" | "readonly_attachment" | "external";

export interface SandboxResolution {
  readonly rawPath: string;
  /** Canonical absolute path: symlinks resolved, missing tails kept as given. */
  readonly resolvedPath: string;
  readonly access: SandboxAccess;
  readonly classification: SandboxClassification;
  readonly denied: boolean;
  readonly writeDeniedReason?: string;
}

export interface WorkspaceSandboxOptions {
  readonly cwd: string | null;
  readonly extraRoots?: ReadonlyArray<string>;
  readonly readOnlyRoots?: ReadonlyArray<string>;
  /** Host-owned per-session scratch space: writable, outside the project, never read-only. */
  readonly scratchRoots?: ReadonlyArray<string>;
}

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const canonicalizeSync = (target: string): string => {
  try {
    return NodeFS.realpathSync(target);
  } catch {
    return NodePath.resolve(target);
  }
};

const isInside = (child: string, root: string): boolean => {
  const relative = NodePath.relative(root, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/**
 * Resolves existing ancestors so a symlinked parent (`./link -> /outside`) is followed
 * before a new file inside it is classified.
 */
export const canonicalizePath = async (target: string): Promise<string> => {
  const suffix: Array<string> = [];
  let current = NodePath.resolve(target);
  while (true) {
    try {
      const real = await NodeFSP.realpath(current);
      return suffix.length === 0 ? real : NodePath.join(real, ...suffix.toReversed());
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return NodePath.join(current, ...suffix.toReversed());
      const parent = NodePath.dirname(current);
      if (parent === current) return NodePath.resolve(target);
      suffix.push(NodePath.basename(current));
      current = parent;
    }
  }
};

const uniqueRoots = (roots: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(roots)];

export class WorkspaceSandbox {
  readonly #cwd: string | null;
  readonly #workspaceRoots: ReadonlyArray<string>;
  readonly #readOnlyRoots: ReadonlyArray<string>;
  readonly #scratchRoots: ReadonlyArray<string>;

  constructor(options: WorkspaceSandboxOptions) {
    this.#cwd = options.cwd === null ? null : canonicalizeSync(options.cwd);
    this.#workspaceRoots = uniqueRoots([
      ...(this.#cwd === null ? [] : [this.#cwd]),
      ...(options.extraRoots ?? []).map(canonicalizeSync),
    ]);
    this.#readOnlyRoots = uniqueRoots((options.readOnlyRoots ?? []).map(canonicalizeSync));
    this.#scratchRoots = uniqueRoots((options.scratchRoots ?? []).map(canonicalizeSync));
  }

  get cwd(): string | null {
    return this.#cwd;
  }

  get workspaceRoots(): ReadonlyArray<string> {
    return this.#workspaceRoots;
  }

  get readOnlyRoots(): ReadonlyArray<string> {
    return this.#readOnlyRoots;
  }

  get scratchRoots(): ReadonlyArray<string> {
    return this.#scratchRoots;
  }

  classify(resolvedPath: string): SandboxClassification {
    // Scratch is checked first so a data directory inside a workspace stays controlled.
    if (this.#scratchRoots.some((root) => isInside(resolvedPath, root))) return "scratch";
    if (this.#workspaceRoots.some((root) => isInside(resolvedPath, root))) return "workspace";
    if (this.#readOnlyRoots.some((root) => isInside(resolvedPath, root)))
      return "readonly_attachment";
    return "external";
  }

  async resolvePath(rawPath: string, access: SandboxAccess): Promise<SandboxResolution> {
    if (rawPath.trim() === "") throw new Error("A path is required.");
    const absolute = NodePath.isAbsolute(rawPath)
      ? rawPath
      : this.#cwd === null
        ? undefined
        : NodePath.join(this.#cwd, rawPath);
    if (absolute === undefined) {
      throw new Error(
        `Cannot resolve "${rawPath}": the session has no workspace folder. Use an absolute path.`,
      );
    }

    const resolvedPath = await canonicalizePath(absolute);
    const classification = this.classify(resolvedPath);
    const denied = access === "write" && classification === "readonly_attachment";
    return {
      rawPath,
      resolvedPath,
      access,
      classification,
      denied,
      ...(denied
        ? {
            writeDeniedReason: `${resolvedPath} is an attachment and is read-only; copy it into the workspace before changing it.`,
          }
        : {}),
    };
  }

  resolvePathSync(rawPath: string, access: SandboxAccess): SandboxResolution {
    if (rawPath.trim() === "") throw new Error("A path is required.");
    const absolute = NodePath.isAbsolute(rawPath)
      ? rawPath
      : this.#cwd === null
        ? undefined
        : NodePath.join(this.#cwd, rawPath);
    if (absolute === undefined) {
      throw new Error(
        `Cannot resolve "${rawPath}": the session has no workspace folder. Use an absolute path.`,
      );
    }
    const resolvedPath = canonicalizeSync(absolute);
    const classification = this.classify(resolvedPath);
    const denied = access === "write" && classification === "readonly_attachment";
    return {
      rawPath,
      resolvedPath,
      access,
      classification,
      denied,
      ...(denied
        ? {
            writeDeniedReason: `${resolvedPath} is an attachment and is read-only; copy it into the workspace before changing it.`,
          }
        : {}),
    };
  }
}
