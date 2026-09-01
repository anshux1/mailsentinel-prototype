# Agent workflow

`main` is stable and `integration` is the shared merge branch. Every agent works in its own worktree and branch:

```bash
git worktree add ../ms-web -b agent/web-setup integration
git worktree add ../ms-app -b agent/app-setup integration
git worktree add ../ms-analyzer -b agent/analyzer-setup integration
git worktree add ../ms-platform -b agent/platform-setup integration
```

Keep commits small, run the relevant verification before pushing, and never share a working directory. Platform owns root configuration; contract and migration changes require review.
