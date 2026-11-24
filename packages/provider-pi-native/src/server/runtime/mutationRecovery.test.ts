import { describe, expect, it } from "vite-plus/test";

import { detectShellFilePatch, MAX_STRIKES, MutationRecoveryTracker } from "./mutationRecovery.ts";

const file = "/workspace/src/file.ts";

const patchReason = (command: string): string | undefined => {
  const result = detectShellFilePatch(command);
  return result.isPatch ? result.reason : undefined;
};

const isPatch = (command: string): boolean => detectShellFilePatch(command).isPatch;

describe("MutationRecoveryTracker", () => {
  it("grants one free retry for the first recoverable failure", () => {
    const tracker = new MutationRecoveryTracker();
    expect(MAX_STRIKES).toBe(3);

    const state = tracker.recordFailure(file, "EDIT_TAG_MISMATCH");
    expect(state).toMatchObject({ strikes: 0, freeRetryUsed: true, hardStop: false });
    expect(state.message).toContain("One free retry");
  });

  it("counts strikes after the free retry and hard-stops at three", () => {
    const tracker = new MutationRecoveryTracker();
    tracker.recordFailure(file, "EDIT_LINES_UNSEEN");

    const second = tracker.recordFailure(file, "EDIT_LINES_UNSEEN");
    expect(second).toMatchObject({ strikes: 1, hardStop: false });

    const third = tracker.recordFailure(file, "EDIT_TAG_UNKNOWN");
    expect(third).toMatchObject({ strikes: 2, hardStop: false });

    const fourth = tracker.recordFailure(file, "EDIT_TAG_MISMATCH");
    expect(fourth).toMatchObject({ strikes: 3, hardStop: true });
    expect(fourth.message).toContain("Stop mutating");
    expect(fourth.message).toContain("ask the user");

    const fifth = tracker.recordFailure(file, "EDIT_TAG_MISMATCH");
    expect(fifth).toMatchObject({ strikes: 3, hardStop: true });
  });

  it("counts non-recoverable failures immediately", () => {
    const tracker = new MutationRecoveryTracker();
    const state = tracker.recordFailure(file, "EDIT_RANGE_INVALID");
    expect(state).toMatchObject({ strikes: 1, freeRetryUsed: false, hardStop: false });

    const unlabelled = tracker.recordFailure(file);
    expect(unlabelled.strikes).toBe(2);
  });

  it("resets strikes and the free retry after a success", () => {
    const tracker = new MutationRecoveryTracker();
    tracker.recordFailure(file, "EDIT_TAG_MISMATCH");
    tracker.recordFailure(file, "EDIT_TAG_MISMATCH");
    expect(tracker.peek(file)?.strikes).toBe(1);

    tracker.recordSuccess(file);
    expect(tracker.peek(file)).toBeUndefined();

    const state = tracker.recordFailure(file, "EDIT_TAG_MISMATCH");
    expect(state).toMatchObject({ strikes: 0, freeRetryUsed: true });
  });

  it("tracks each file separately", () => {
    const tracker = new MutationRecoveryTracker();
    tracker.recordFailure(file, "EDIT_RANGE_INVALID");
    tracker.recordFailure(file, "EDIT_RANGE_INVALID");
    tracker.recordFailure(file, "EDIT_RANGE_INVALID");
    expect(tracker.peek(file)?.hardStop).toBe(true);
    expect(tracker.peek(`${file}.other`)).toBeUndefined();
  });
});

describe("detectShellFilePatch", () => {
  it("flags output redirections that write files", () => {
    expect(patchReason("echo hello > notes.txt")).toContain("writes a file");
    expect(isPatch("echo hello >> notes.txt")).toBe(true);
    expect(isPatch("echo hello 1> notes.txt")).toBe(true);
    expect(isPatch("echo hello >| notes.txt")).toBe(true);
    expect(isPatch("echo hello &> notes.txt")).toBe(true);
  });

  it("flags in-place editors and patch tools", () => {
    expect(patchReason("sed -i 's/a/b/' file.txt")).toContain("sed");
    expect(isPatch("sed --in-place 's/a/b/' file.txt")).toBe(true);
    expect(patchReason("perl -pi -e 's/a/b/' file.txt")).toContain("perl");
    expect(isPatch("cat log | tee out.log")).toBe(true);
    expect(isPatch("patch < change.diff")).toBe(true);
    expect(isPatch("git apply fix.patch")).toBe(true);
  });

  it("flags inline interpreter scripts that write", () => {
    expect(isPatch(`python3 -c "open('out.txt','w').write('x')"`)).toBe(true);
    expect(isPatch(`node -e "require('fs').writeFileSync('out.txt','x')"`)).toBe(true);
    expect(isPatch(`python3 -c "print(1)"`)).toBe(false);
    expect(isPatch(`node -e "console.log(1)"`)).toBe(false);
  });

  it("ignores quotes, pipes to readers, and null-device redirections", () => {
    expect(isPatch('echo "a > b"')).toBe(false);
    expect(isPatch("echo 'sed -i is dangerous'")).toBe(false);
    expect(isPatch("cat foo | grep bar")).toBe(false);
    expect(isPatch("git diff")).toBe(false);
    expect(isPatch("git status")).toBe(false);
    expect(isPatch("ls > /dev/null")).toBe(false);
    expect(isPatch("rg needle . > /dev/null 2>&1")).toBe(false);
    expect(isPatch("cat log | tee /dev/null")).toBe(false);
  });

  it("ignores heredoc bodies and looks at the heredoc command itself", () => {
    expect(isPatch("cat <<'EOF'\nrm -rf /tmp/x\nsed -i 's/a/b/' f\nEOF")).toBe(false);
    expect(isPatch("cat > out.txt <<'EOF'\nbody\nEOF")).toBe(true);
  });

  it("does not treat escaped characters or continuations as operators", () => {
    expect(isPatch("echo a \\> b.txt")).toBe(false);
    expect(isPatch("echo first \\\n  second")).toBe(false);
  });
});
