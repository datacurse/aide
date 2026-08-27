# .aide

Project state for aide, kept as plain files so it stays readable, diffable, and
portable. If aide disappears, this directory is still a description of the project.

| Path | What |
| --- | --- |
| `project.md` | Why this exists, constraints, non-goals. You write it. |
| `tasks/` | One markdown file per unit of work. Body is the agent prompt. |
| `inbox.md` | Freeform dump zone. Consumed by the intake pass. |
| `specs/` | One file per feature area. |
| `roadmap.md` | Generated, ordered, references spec ids. |
| `journal/` | What agents did, written automatically. |
| `decisions/` | ADRs. |
| `worktrees/` | Per-task git worktrees. Gitignored. |
