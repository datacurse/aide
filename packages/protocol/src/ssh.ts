/**
 * `~/.aide/ssh_config` — the machines aide can reach, in OpenSSH's own format.
 *
 * The same file shape VS Code's Remote-SSH reads, and deliberately not a JSON
 * file of aide's own invention: everyone who would use this already has one of
 * these, and the point of matching the format is that it can be pasted in whole.
 *
 * aide's OWN file, though, under `~/.aide/`, rather than reading `~/.ssh/config`
 * in place. Two reasons, and the second is the one that matters. The first is
 * that `~/.ssh/config` is a security-relevant file that belongs to ssh, and a
 * dashboard that rewrites it when you add a host is doing something nobody asked
 * for. The second: this parser understands a SUBSET, and a real config can
 * contain `Match` blocks, `ProxyJump`, tokens like `%h`, and includes — read
 * those with a partial parser and aide would silently show a host list that
 * disagrees with what `ssh` itself does. A separate file is honest about being a
 * separate, smaller thing. `Include ~/.ssh/config` is not supported for exactly
 * that reason.
 *
 * Parsed here, in the browser-safe half, because the host list is drawn in the
 * picker and the daemon resolves it to a connection — both ends compile from
 * this, which is what keeps them agreeing about what a host is called.
 */

/** One `Host` block, reduced to what aide needs to open a connection. */
export interface SshHost {
  /**
   * The name in the `Host` line — the label, and the identity.
   *
   * What you pick in the UI and what `ssh` is ultimately handed. It is NOT
   * necessarily a hostname: `Host orangepi` with `HostName 192.168.3.81` is the
   * common case, and the whole reason the two fields are separate.
   */
  alias: string
  /** `HostName`. Falls back to the alias, which is what ssh itself does. */
  hostName: string
  /** `User`, or null to let ssh decide (its own config, then the local username). */
  user: string | null
  /** `IdentityFile`, `~` unexpanded — only the daemon knows whose home this is. */
  identityFile: string | null
  /** `Port`. Null means 22, left unstated rather than assumed. */
  port: number | null
  /** 1-based line of the `Host` line, so an error can point at the file. */
  line: number
}

/**
 * A `Host` line may name several patterns and may contain wildcards.
 *
 * `Host *` and `Host prod-*` are settings-for-many, not machines-you-can-pick:
 * there is nothing to connect to, because the name is a pattern rather than an
 * address. They parse fine and are simply not offered as choices — dropping them
 * silently at parse time would make a host you wrote and cannot find into a
 * mystery, so `parseSshConfig` keeps them and `connectableHosts` filters.
 */
export const isPattern = (alias: string) => /[*?!]/.test(alias)

/** Hosts a person can actually pick. See `isPattern`. */
export const connectableHosts = (hosts: readonly SshHost[]): SshHost[] =>
  hosts.filter((h) => !isPattern(h.alias))

/**
 * One line into a keyword and its value.
 *
 * OpenSSH accepts `Key value`, `Key=value` and whitespace around the `=`, and
 * treats the keyword case-insensitively — `HostName`, `hostname` and `HOSTNAME`
 * are one keyword. Values keep their case, because a path and a username do.
 *
 * Quotes are stripped because a path with a space in it is written `"C:/Program
 * Files/key"` and would otherwise arrive with the quotes as part of the path,
 * which fails as a filename rather than as a config error.
 */
function splitLine(raw: string): { keyword: string; value: string } | null {
  const line = raw.trim()
  // `#` only at the start of a line. OpenSSH does not take trailing comments,
  // and stripping them here would corrupt any value containing a `#`.
  if (!line || line.startsWith("#")) return null

  const match = /^([A-Za-z][A-Za-z0-9-]*)(?:\s*=\s*|\s+)(.*)$/.exec(line)
  if (!match) return null
  const [, keyword = "", rest = ""] = match

  let value = rest.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1)
  }
  return { keyword: keyword.toLowerCase(), value }
}

/**
 * The file into a list of hosts, in the order they were written.
 *
 * Order is preserved rather than sorted, because it is the order you keep your
 * own machines in and a list that reshuffles itself is one you have to re-read
 * every time.
 *
 * Never throws. A malformed line is skipped rather than failing the file: unlike
 * `project.md`, where a typo means a gate silently stopped running, the worst
 * case here is a host that does not appear — which is visible in the picker,
 * where the person who just edited the file is looking. Refusing to parse the
 * whole file because of one bad line would hide every OTHER machine too.
 */
export function parseSshConfig(text: string): SshHost[] {
  const hosts: SshHost[] = []
  /**
   * The aliases sharing the `Host` line currently being read.
   *
   * A local, not a module-level variable, and that is the whole reason this
   * comment exists: held outside the function it would survive between calls, so
   * a second file beginning with a stray `User` line would quietly write that
   * user onto the LAST host of the file parsed before it.
   */
  let siblings: SshHost[] = []

  text.split(/\r?\n/).forEach((raw, index) => {
    const parsed = splitLine(raw)
    if (!parsed) return
    const { keyword, value } = parsed

    if (keyword === "host") {
      // One `Host` line can name several aliases sharing a block. Each becomes
      // its own row, and every keyword that follows applies to all of them —
      // which is why this is a list rather than a single current host.
      siblings = value
        .split(/\s+/)
        .filter(Boolean)
        .map((alias) => ({
          alias,
          hostName: alias,
          user: null,
          identityFile: null,
          port: null,
          line: index + 1,
        }))
      hosts.push(...siblings)
      return
    }

    // A keyword before any `Host` line is a global default. aide has no use for
    // one — every value it reads is per-machine — so it is skipped rather than
    // applied to everything.
    if (!siblings.length) return

    for (const host of siblings) {
      if (keyword === "hostname") host.hostName = value
      else if (keyword === "user") host.user = value
      else if (keyword === "identityfile") host.identityFile = value
      else if (keyword === "port") {
        const port = Number(value)
        // A port that is not a number is left null rather than stored as NaN,
        // which would reach the command line as the literal string "NaN".
        if (Number.isInteger(port) && port > 0 && port < 65536) host.port = port
      }
    }
  })

  return hosts
}

/** One directory on a remote machine, as the picker draws it. */
export interface SshDirectory {
  /** Bare name, not a path — the listing's own `path` says where it is. */
  name: string
  /**
   * Whether this directory holds a `.git`, and can therefore be added.
   *
   * Answered in the same round trip as the listing rather than by asking about
   * each folder in turn, because each question is a whole ssh connection. See
   * `listRemoteDirectories`.
   */
  isRepo: boolean
}

/** What a machine answered when asked what is in a directory. */
export interface SshListing {
  /** The alias it was asked through. */
  host: string
  /**
   * The directory listed, ABSOLUTE, as the far side resolved it.
   *
   * Resolved rather than echoed back, because the path that was sent may have
   * been `.` or empty — meaning the remote home directory, whose location is not
   * something this end knows. Walking up from a relative path is guesswork; from
   * an absolute one it is `dirname`.
   */
  path: string
  directories: SshDirectory[]
}

/**
 * What a fresh `~/.aide/ssh_config` says.
 *
 * Written on first use so the file exists to be edited, rather than being a path
 * mentioned in an error message that the person then has to create by hand. The
 * example is commented out: an aide that ships with a machine already listed
 * would show a host nobody can reach.
 */
export const SSH_CONFIG_TEMPLATE = `# Machines aide can add projects from, in OpenSSH's format.
#
# The same shape as ~/.ssh/config, kept separately so aide never rewrites the
# file ssh itself reads. Paste your hosts in, or write them here.
#
# aide reads Host, HostName, User, Port and IdentityFile. Match blocks,
# ProxyJump, Include and %-tokens are NOT understood — a host needing one of
# those will not connect from here even though ssh handles it on the command
# line.
#
# Host orangepi
#   HostName 192.168.3.81
#   User orangepi
#   IdentityFile ~/.ssh/id_ed25519
`

/**
 * The `[user@]host` argument for an ssh command line, port excluded.
 *
 * The alias rather than the HostName, so that a host whose block carries
 * settings this parser does not understand still reaches ssh by the name its own
 * config knows it by.
 */
export const sshTarget = (host: SshHost): string =>
  host.user ? `${host.user}@${host.alias}` : host.alias
