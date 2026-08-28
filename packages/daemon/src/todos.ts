import { readFile, writeFile } from "node:fs/promises"
import type { Project, Todo, TodoFile } from "@aide/protocol"
import {
  appendTodo,
  DEFAULT_TODOS,
  parseTodos,
  removeTodo,
  replaceTodo,
  serializeTodos,
  todosOf,
} from "@aide/protocol"
import { specPath, todosPath } from "@aide/protocol/node"
import { maxRowIdInHistory } from "./repo.js"

/**
 * `.aide/todos.md` and `.aide/spec.md`, the two files the board reads.
 *
 * Both are git-tracked and both are agent-writable. Neither carries status:
 * a verdict shows up here as the SHAPE of the file — done and dropped delete the
 * row, failed leaves it — so there is no `status:` field to drift out of sync
 * with what actually happened.
 *
 * `todos.md` is written by the daemon and excluded from everything an agent can
 * stage — see `AGENT_SCOPE`. Runs share the checkout with the daemon now, so
 * that exclusion stopped being about stale copies on branches and became a plain
 * race: the daemon rewrites this file as rows open and close, while a run is
 * editing the same tree the review is about to commit from.
 */

async function read(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch {
    // A project that has never had one is not an error — it is a project with an
    // empty backlog, and the board should render rather than 500.
    return fallback
  }
}

export async function readTodoFile(project: Project): Promise<TodoFile> {
  return parseTodos(await read(todosPath(project.root), DEFAULT_TODOS))
}

export async function writeTodoFile(project: Project, file: TodoFile): Promise<void> {
  await writeFile(todosPath(project.root), serializeTodos(file), "utf8")
}

export async function listTodos(project: Project): Promise<Todo[]> {
  return todosOf(await readTodoFile(project))
}

/**
 * Add a row.
 *
 * Returns the todo rather than void because the caller needs the id it was
 * given: it is the join key for the board and half the branch name, and there is
 * no second read that would recover which of several identical texts is the new
 * one.
 */
export async function addTodo(project: Project, text: string): Promise<Todo> {
  if (!text.trim()) throw new Error("a todo needs some text")
  // The floor comes from git, not from this file. A closed row is deleted from
  // the backlog while the commits it produced live on carrying its number in an
  // `Aide-Row` trailer, so numbering from the file alone would hand `0003` out
  // twice and make the history view attribute one row's commits to another.
  const floor = await maxRowIdInHistory(project.root)
  const { file, todo } = appendTodo(await readTodoFile(project), text, floor)
  await writeTodoFile(project, file)
  return todo
}

export async function editTodo(project: Project, id: string, text: string): Promise<Todo> {
  if (!text.trim()) throw new Error("a todo needs some text")
  const file = await readTodoFile(project)
  if (!todosOf(file).some((t) => t.id === id)) throw new Error(`no todo ${id}`)
  await writeTodoFile(project, replaceTodo(file, id, text))
  return { id, text: text.trim() }
}

export async function deleteTodo(project: Project, id: string): Promise<void> {
  const file = await readTodoFile(project)
  if (!todosOf(file).some((t) => t.id === id)) throw new Error(`no todo ${id}`)
  await writeTodoFile(project, removeTodo(file, id))
}

export async function findTodo(project: Project, id: string): Promise<Todo | undefined> {
  return (await listTodos(project)).find((t) => t.id === id)
}

/** The spec, verbatim. Empty string when the project has none yet. */
export async function readSpec(project: Project): Promise<string> {
  return read(specPath(project.root), "")
}
