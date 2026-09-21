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

On Linux, install bubblewrap 0.9 or later. For Debian and Ubuntu:

```sh
sudo apt install bubblewrap
```

## Technical choices

pi-shorthand gives Pi a programming environment instead of a patch format. This makes multi-file and structural edits possible in one call, but does not guarantee that Pi will find it easier or more reliable than its built-in edit tool. Which works better depends on the model and the task.

Programs edit an isolated snapshot, with host files outside the repository kept read-only. By default, a failure keeps completed files and rolls back files involved in failed or interrupted edits; changes are applied only if their destination files have not changed.
