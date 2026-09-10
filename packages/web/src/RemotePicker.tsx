/**
 * Pick a machine from `~/.aide/ssh_config`, then walk it for a repository.
 *
 * The local `add` opens the machine's own folder dialog, which is the right
 * answer there and impossible here: there is no dialog on the far side of an ssh
 * connection, and no window to open it on. So this is aide drawing a folder list
 * itself — the one place the app does, and only because nothing else can.
 *
 * Two columns rather than a tree. A tree keeps the whole walk on screen and
 * invites you to open six of them, which for a listing that costs a network
 * round trip each is six connections to a Raspberry Pi. One directory at a time
 * makes the cost of looking obvious, which is what you want when looking is slow.
 */
import { useCallback, useEffect, useState } from "react"
import type { SshHost, SshListing } from "@aide/protocol"
import { api } from "./api"
import { Hint } from "./Hint"
import { Button } from "./ui"

/** The parent of a POSIX path, or null at the root. */
function parentOf(path: string): string | null {
  if (!path || path === "/") return null
  const trimmed = path.replace(/\/+$/, "")
  const cut = trimmed.lastIndexOf("/")
  if (cut < 0) return null
  // `/home` -> `/`, not the empty string, which would list the wrong thing.
  return cut === 0 ? "/" : trimmed.slice(0, cut)
}

const join = (base: string, name: string) =>
  base.endsWith("/") ? `${base}${name}` : `${base}/${name}`

export function RemotePicker({
  onPick,
  onCancel,
}: {
  /** The chosen repository, as `host` and an absolute remote path. */
  onPick: (host: SshHost, path: string) => void
  onCancel: () => void
}) {
  const [hosts, setHosts] = useState<SshHost[] | null>(null)
  const [configPath, setConfigPath] = useState("")
  const [host, setHost] = useState<SshHost | null>(null)
  const [listing, setListing] = useState<SshListing | null>(null)
  /**
   * The path last asked for, which is NOT `listing.path`.
   *
   * They differ in exactly the case that matters: when a listing fails there is
   * no listing to read a path off, and the failure is the moment you most want
   * to try the same path again. It is also the un-resolved form — `.` for the
   * remote home directory — because that is what the daemon knows how to expand.
   */
  const [lastPath, setLastPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .sshHosts()
      .then((r) => {
        setHosts(r.hosts)
        setConfigPath(r.configPath)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  /**
   * Walk to a directory on the selected machine.
   *
   * The previous listing stays on screen while this is in flight rather than
   * being cleared to a spinner: a folder list that empties itself every time you
   * step into something reads as the connection having dropped, and the step
   * usually takes long enough for that to register.
   */
  const walk = useCallback(
    async (target: SshHost, path: string) => {
      setBusy(true)
      setError(null)
      setLastPath(path)
      try {
        setListing(await api.sshList(target.alias, path))
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const chooseHost = (h: SshHost) => {
    setHost(h)
    setListing(null)
    // "." rather than a path: the daemon resolves it to the remote home
    // directory and tells us what it was, which is not something this end knows.
    void walk(h, ".")
  }

  const parent = listing ? parentOf(listing.path) : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel()
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add a project over ssh"
        autoFocus
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[28rem] w-[40rem] max-w-full flex-col rounded border border-line bg-chrome font-sans shadow-lg outline-none"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
          <p className="text-[13px] text-fg">
            {host ? `${host.alias}` : "add a project over ssh"}
          </p>
          {host && (
            <Button
              onClick={() => {
                setHost(null)
                setListing(null)
                setLastPath(null)
                setError(null)
              }}
            >
              machines
            </Button>
          )}
        </div>

        {/* The path being browsed, and the way back up. */}
        {host && listing && (
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
            <Button
              disabled={!parent || busy}
              onClick={() => parent && host && void walk(host, parent)}
            >
              up
            </Button>
            <Hint hint={listing.path}>
              <span className="truncate font-mono text-[11px] text-fg-dim">{listing.path}</span>
            </Hint>
          </div>
        )}

        <div className="flex-1 overflow-auto p-1">
          {error && (
            <div className="m-2 rounded-sm bg-diff-del-fg/15 px-2 py-1.5">
              <p className="text-[11px] leading-relaxed text-diff-del-fg">{error}</p>
              {/* The way out of a dead end, and the reason it is here rather
                  than only in the foot: a failed FIRST listing leaves `listing`
                  null, so the path bar that carries `up` does not render and
                  the folder list is empty. Without this the dialog offers a
                  sentence, `machines`, and `cancel` — and the fix for most of
                  these errors (accept a host key, unlock a key, wake the
                  machine) is done elsewhere and then retried, which was the one
                  thing you could not do. */}
              {host && lastPath !== null && (
                <div className="mt-1.5">
                  <Button
                    disabled={busy}
                    onClick={() => void walk(host, lastPath)}
                  >
                    {busy ? "retrying…" : "retry"}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Machines */}
          {!host &&
            (hosts === null ? null : hosts.length === 0 ? (
              <p className="p-4 text-center text-xs leading-relaxed text-fg-dim">
                No machines yet. Add them to
                <br />
                <span className="font-mono text-[11px] text-fg-muted">{configPath}</span>
                <br />
                in the same format as <span className="font-mono text-[11px]">~/.ssh/config</span>.
              </p>
            ) : (
              hosts.map((h) => (
                <button
                  key={h.alias}
                  type="button"
                  onClick={() => chooseHost(h)}
                  className="flex w-full items-baseline gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-raised"
                >
                  <span className="text-[13px] text-fg">{h.alias}</span>
                  {/* The address, when it is not just the name again. */}
                  <span className="truncate font-mono text-[11px] text-fg-dim">
                    {h.user ? `${h.user}@` : ""}
                    {h.hostName === h.alias ? "" : h.hostName}
                    {h.port ? `:${h.port}` : ""}
                  </span>
                </button>
              ))
            ))}

          {/* Directories */}
          {host && listing && (
            <>
              {/* `!error` as well, or a failed step renders the same as a
                  directory that genuinely holds nothing — the two need
                  different reactions and looked identical. */}
              {listing.directories.length === 0 && !busy && !error && (
                <p className="p-4 text-center text-xs text-fg-dim">
                  No folders in here.
                  {/* The repository you are standing in is added from the foot,
                      so an empty listing is not necessarily a dead end. */}
                </p>
              )}
              {listing.directories.map((d) => (
                <div
                  key={d.name}
                  className="flex items-center justify-between gap-2 rounded-sm px-2 py-1 hover:bg-raised"
                >
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void walk(host, join(listing.path, d.name))}
                    className="flex-1 truncate text-left font-mono text-xs text-fg disabled:opacity-50"
                  >
                    {d.name}
                    {/* A repository is marked, not filtered out: you still have
                        to walk THROUGH ordinary folders to reach one. */}
                    {d.isRepo && <span className="ml-2 text-[10px] text-accent">git</span>}
                  </button>
                  {d.isRepo && (
                    <Button
                      tone="primary"
                      disabled={busy}
                      onClick={() => onPick(host, join(listing.path, d.name))}
                    >
                      add
                    </Button>
                  )}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-line px-3 py-2">
          <span className="text-[11px] text-fg-dim">{busy ? "listing…" : ""}</span>
          <div className="flex gap-1.5">
            <Button onClick={onCancel}>cancel</Button>
            {/* Adding the directory you are standing IN, which is the case the
                rows above cannot offer: you walked into a repository to look at
                it and it is the one you want. */}
            {/* Not while an error is up. `listing` still holds the last
                directory that WORKED, so after a failed step this button would
                offer to add a folder other than the one named in the path bar
                above it — the wrong repository, silently. */}
            {host && listing && !error && (
              <Button tone="primary" disabled={busy} onClick={() => onPick(host, listing.path)}>
                add this folder
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
