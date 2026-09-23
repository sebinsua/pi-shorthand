# pi-shorthand

![A code call in Pi](https://raw.githubusercontent.com/sebinsua/pi-shorthand/main/docs/screenshot.png?v=2)

A [Pi](https://github.com/earendil-works/pi) tool for editing repositories with Bun programs.

## Install

Install pi-shorthand and initialize Grit:

```sh
pi install npm:pi-shorthand
npx @getgrit/cli init --global
```

On macOS, install clang and AgentFS:

```sh
xcode-select --install
curl -fsSL https://agentfs.ai/install | bash
```

On Linux, install bubblewrap 0.11 or later, a C compiler, and `lsof`. For Debian and Ubuntu, check the available bubblewrap version before installing:

```sh
apt-cache policy bubblewrap
sudo apt install bubblewrap build-essential lsof
```

## Technical choices

pi-shorthand gives Pi a programming environment instead of a patch format. This makes multi-file and structural edits possible in one call, but does not guarantee that Pi will find it easier or more reliable than its built-in edit tool. Which works better depends on the model and the task.

Programs edit a private workspace, with host files outside the repository kept read-only. By default, a failure keeps completed files and rolls back failed or interrupted edits. Concurrent edits can cause a run to be rejected; conflict detection is best-effort, not an atomic commit.

The `code` tool uses Pi's working directory by default. Pass `cwd` to target another checkout; relative paths are resolved from Pi's working directory. For example, when Pi starts in a bare worktree container, `cwd: "child"` targets its `child` worktree. The chosen directory must be inside a Git worktree.
