# ADR 0006: Agent workflow

- **Context:** Parallel agents must not mutate the same checkout.
- **Decision:** One branch/worktree per workstream, with integration as the merge point.
- **Alternatives:** Multiple terminals in one directory.
- **Consequences:** Clean reviewable history and fewer file races.
- **Reversal:** None required; worktrees are operational only.
