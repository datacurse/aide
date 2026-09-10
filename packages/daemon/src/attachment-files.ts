/**
 * Non-image attachments, turned into files the agent can Read.
 *
 * An image rides the Messages API as a vision block; everything else — an STL,
 * a zip, a log dump — has no block type to ride in, and the agent it is going
 * to has a filesystem. So the worker writes each one into a temp folder on the
 * machine that RUNS the agent (this code executes inside the worker, which for
 * a remote project is `aide-agent` on the far machine — the one place a path
 * in the message can be true), and the message text names the paths.
 *
 * Pure on purpose, and separate from `agent.ts`, which imports the SDK at
 * module load: `pnpm smoke` pins the two halves that fail quietly — a name
 * that collides or escapes the folder, and a note that lists fewer files than
 * were written — without dragging the SDK into a policy run.
 */

/**
 * One safe, unique filename per attachment, in order.
 *
 * The browser hands over a bare basename, but nothing enforces that, so only
 * the last path segment survives — a name with a separator in it would
 * otherwise write outside the folder the note points at. Characters Windows
 * refuses are replaced rather than dropped, so two names differing only in
 * them still differ. Collisions get `-2`-style suffixes before the extension:
 * two files called `part.stl` dropped from two folders are the normal case,
 * not an error. The taken-set compares case-insensitively, because the
 * filesystems these land on do.
 */
export function fileAttachmentNames(files: { name?: string }[]): string[] {
  const taken = new Set<string>()
  return files.map((f, i) => {
    const last = (f.name ?? "").split(/[\\/]/).pop() ?? ""
    // Trailing dots and spaces stripped as well: Windows silently drops them
    // at create time, so the path in the note would not match the file.
    let base = last.replace(/[<>:"|?*\x00-\x1f]/g, "-").replace(/[. ]+$/, "")
    if (!base) base = `file-${i + 1}`
    const dot = base.lastIndexOf(".")
    const stem = dot > 0 ? base.slice(0, dot) : base
    const ext = dot > 0 ? base.slice(dot) : ""
    let candidate = base
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem}-${n}${ext}`
    taken.add(candidate.toLowerCase())
    return candidate
  })
}

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`

/**
 * The sentence the message carries in place of the bytes.
 *
 * Appended to the user's own text rather than sent as a block of its own, so a
 * replayed transcript — which shows the message as the SDK stored it — still
 * says what was attached and where it went. "Outside the repository" is said
 * out loud because it is the fact that stops an agent spending a turn working
 * out why the commit gate never mentions them.
 */
export function attachedFilesNote(files: { path: string; bytes: number }[]): string {
  const rows = files.map((f) => `- ${f.path} (${size(f.bytes)})`).join("\n")
  return `Files attached to this message, written to a temp folder outside the repository. Read them from these paths:\n${rows}`
}
