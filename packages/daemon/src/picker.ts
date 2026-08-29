import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import type { FolderPick } from "@aide/protocol"

/**
 * The machine's own folder dialog, opened by the daemon.
 *
 * It has to be the daemon's and not the browser's, because a page cannot produce
 * an absolute path on purpose: `showDirectoryPicker()` hands back a handle and a
 * bare directory name, and `<input webkitdirectory>` gives paths relative to
 * whatever you chose. Neither says where on disk it is. The registry stores
 * absolute paths, so the only side of the wire that can answer is the side
 * already standing on the filesystem.
 *
 * That is worth being uneasy about rather than pleased with — it is an HTTP
 * request that opens a window on somebody's screen. It is only reasonable
 * because aide is one person on their own machine behind loopback, and the
 * origin guard in `server.ts` is what keeps that true.
 */

interface Ran {
  code: number
  out: string
  err: string
}

/**
 * Run a dialog and read its answer, WITHOUT reading a non-zero exit as a
 * failure: Cancel is exit 1 for both zenity and osascript, and that is a normal
 * outcome rather than a crash. A binary that is not installed is the case that
 * has to stay distinguishable, so a spawn error — a string `code` like ENOENT —
 * still throws.
 */
function run(file: string, args: string[]): Promise<Ran> {
  return new Promise((resolve, reject) => {
    // `windowsHide` looks contradictory next to a dialog and is not: it hides the
    // helper's CONSOLE window, which would otherwise flash black in the middle of
    // the screen. The GUI window that helper then opens is unaffected.
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      const code = error?.code
      if (typeof code === "string") return reject(error)
      resolve({ code: code ?? 0, out: stdout, err: stderr })
    })
  })
}

/** A chosen directory, minus the trailing separator some dialogs add. */
const withoutTrailingSlash = (path: string) =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/** Single quotes are PowerShell's literal string, and doubling one escapes it. */
const psLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`

/**
 * The shell's folder picker, reached through COM.
 *
 * The obvious route is `System.Windows.Forms.FolderBrowserDialog`, and on
 * Windows PowerShell it is the wrong one: that assembly is .NET Framework's, and
 * .NET Framework never got the modern dialog. Checked on Windows 11 — the type
 * has seven properties, no `AutoUpgradeEnabled` and no `UseDescriptionForTitle`,
 * which means it is still the XP tree from 2001: no address bar, no Quick
 * Access, and nowhere to paste a path. The Vista-style folder picker arrived in
 * WinForms with .NET Core 3.0, and there is no `pwsh` to be assumed here.
 *
 * So this asks the shell for it directly. `IFileOpenDialog` with FOS_PICKFOLDERS
 * IS the dialog VS Code shows, because VS Code calls the same thing.
 *
 * The unnamed methods below are vtable slots, not an oversight. A COM interface
 * is an ordered function table, so every method has to be declared to keep the
 * ones after it at the right offset — deleting an unused one silently moves
 * `GetResult` onto `AddPlace` and the answer comes back as a crash.
 */
const PICKER_CS = `
using System;
using System.Runtime.InteropServices;

public static class AideFolderDialog
{
    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes();
        void SetFileTypeIndex();
        void GetFileTypeIndex();
        void Advise();
        void Unadvise();
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void GetResult(out IShellItem item);
        void AddPlace();
        void SetDefaultExtension();
        void Close();
        void SetClientGuid();
        void ClearClientData();
        void SetFilter();
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler();
        void GetParent();
        void GetDisplayName(uint kind, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetAttributes();
        void Compare();
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr context,
        ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    public static string Pick(IntPtr owner, string title, string startIn)
    {
        IFileDialog dialog = (IFileDialog)new FileOpenDialog();

        uint options;
        dialog.GetOptions(out options);
        // PICKFOLDERS turns the file dialog into a folder one. FORCEFILESYSTEM
        // rejects the shell places that have no path on disk - a library, a
        // phone over MTP - which would otherwise come back as something the
        // registry cannot store. NOCHANGEDIR because this is somebody else's
        // process and its working directory is not ours to move.
        dialog.SetOptions(options | 0x20 | 0x40 | 0x8 | 0x800);
        dialog.SetTitle(title);

        if (!string.IsNullOrEmpty(startIn))
        {
            try
            {
                Guid iid = typeof(IShellItem).GUID;
                IShellItem start;
                SHCreateItemFromParsingName(startIn, IntPtr.Zero, ref iid, out start);
                dialog.SetFolder(start);
            }
            catch
            {
                // A hint, not a requirement. A folder that has been moved since
                // it was last used should open the default one, not fail.
            }
        }

        int hr = dialog.Show(owner);
        // ERROR_CANCELLED as an HRESULT. The only non-zero result that is an
        // answer rather than a fault, and the caller has to be able to tell.
        if (hr == unchecked((int)0x800704C7)) return null;
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);

        IShellItem picked;
        dialog.GetResult(out picked);
        string path;
        picked.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
        return path;
    }
}
`

const windowsScript = (startIn: string) => `
$ErrorActionPreference = 'Stop'
# A progress record goes down the error stream as CLIXML the moment stderr is a
# pipe, and Add-Type emits one ("Preparing modules for first use") on every run.
# Without this, the reason a dialog did not open comes back to the browser as a
# line of serialized XML - which is what it did before this line existed.
$ProgressPreference = 'SilentlyContinue'

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @'
${PICKER_CS}
'@

  # The daemon owns no window, so a dialog it opens is placed by z-order alone
  # and lands BEHIND the browser: the button reads as dead, and the dialog is
  # found on the taskbar a minute later. Windows puts an owned window above its
  # owner, and the owned windows of a topmost owner are topmost too, so this one
  # HWND drags the dialog over everything. The owner is never seen itself -
  # fully transparent, with no taskbar button - and exists only to be pointed at.
  $owner = New-Object System.Windows.Forms.Form
  $owner.ShowInTaskbar = $false
  $owner.Opacity = 0
  $owner.Show()
  # TopMost AFTER Show(), which is not a style preference: assigning it to a form
  # whose handle does not exist yet only records it, and $owner.Opacity - which
  # goes through AllowTransparency and rebuilds the extended style - then throws
  # that record away. Measured on Windows 11: TopMost then Opacity then Show()
  # gives exstyle 0x00090100, no WS_EX_TOPMOST, and the dialog opens BEHIND the
  # browser. An owned dialog is in no taskbar and no Alt-Tab, so there is then
  # nothing to find it by: add sits on "choosing..." until the daemon is killed.
  # Past a created handle the setter is a plain SetWindowPos and sticks.
  $owner.TopMost = $true

  $path = [AideFolderDialog]::Pick($owner.Handle, 'Select a git repository', ${psLiteral(startIn)})
  $owner.Close()

  if ($path) {
    # Raw UTF-8 onto the pipe rather than Write-Output, which goes through the
    # console code page - turning every non-ASCII character in the path into a
    # question mark - and through the formatter, which is free to wrap a long
    # line at the console width.
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($path)
    $stdout = [System.Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
  }
} catch {
  # Straight at the stderr handle, which is not PowerShell's error stream and so
  # is not serialized on the way out. Cancelling is not an exception - it is a
  # null path and an exit code of zero - so anything arriving here is a fault.
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`

/**
 * PowerShell's stderr is not text when it is redirected. Anything reaching the
 * error or progress stream arrives as a `#< CLIXML` preamble and a line of
 * serialized objects, and handing that to the browser as the reason a dialog did
 * not open is worse than saying nothing at all. The script above writes its own
 * messages past that machinery; this drops whatever the host still wrapped.
 */
const withoutClixml = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("#< CLIXML") && !line.startsWith("<Objs "))
    .join("\n")
    .trim()

async function windowsPick(startIn: string): Promise<FolderPick> {
  // -EncodedCommand rather than -Command. The script is multi-line and full of
  // quotes, and it carries a path that may contain a space, a bracket or an
  // ampersand; base64 of UTF-16LE is the one form of it that no layer between
  // here and PowerShell gets to reinterpret.
  const encoded = Buffer.from(windowsScript(startIn), "utf16le").toString("base64")
  const { out, err, code } = await run("powershell.exe", [
    "-NoProfile",
    // Both the shell dialog and WinForms want a single-threaded apartment.
    // Windows PowerShell is STA already and PowerShell 7 is not, so it is asked
    // for rather than assumed.
    "-STA",
    "-EncodedCommand",
    encoded,
  ])

  const path = out.trim()
  if (path) return { path, unavailable: null }
  // Cancel exits 0 with nothing on stdout. Anything else means the dialog never
  // opened — no interactive desktop, most likely — and saying so beats handing
  // back something indistinguishable from the human declining.
  if (code !== 0) {
    return { path: null, unavailable: withoutClixml(err) || `powershell exited ${code}` }
  }
  return { path: null, unavailable: null }
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

const osaLiteral = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

async function macPick(startIn: string): Promise<FolderPick> {
  const { out, err, code } = await run("osascript", [
    "-e",
    `set start to POSIX file ${osaLiteral(startIn)}`,
    "-e",
    'POSIX path of (choose folder with prompt "Select a git repository" default location start)',
  ])

  const path = withoutTrailingSlash(out.trim())
  if (code === 0 && path) return { path, unavailable: null }
  // -128 is "User canceled", the one non-zero exit here that is not a fault.
  if (err.includes("-128")) return { path: null, unavailable: null }
  return { path: null, unavailable: err.trim() || `osascript exited ${code}` }
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

async function linuxPick(startIn: string): Promise<FolderPick> {
  // zenity on GTK, kdialog on KDE, and neither is guaranteed to be installed.
  const candidates: Array<[string, string[]]> = [
    [
      "zenity",
      [
        "--file-selection",
        "--directory",
        "--title=Select a git repository",
        // The trailing separator is what makes zenity read this as the folder to
        // open in rather than as a name to preselect.
        `--filename=${startIn}/`,
      ],
    ],
    ["kdialog", ["--title", "Select a git repository", "--getexistingdirectory", startIn]],
  ]

  const missing: string[] = []
  for (const [file, args] of candidates) {
    let ran: Ran
    try {
      ran = await run(file, args)
    } catch {
      missing.push(file)
      continue
    }
    const path = withoutTrailingSlash(ran.out.trim())
    if (path) return { path, unavailable: null }
    // Both report Cancel as exit 1 with an empty stdout.
    if (ran.code === 1) return { path: null, unavailable: null }
    return { path: null, unavailable: ran.err.trim() || `${file} exited ${ran.code}` }
  }

  return {
    path: null,
    unavailable: `no folder dialog on this machine (tried ${missing.join(" and ")})`,
  }
}

// ---------------------------------------------------------------------------

const platformPick = (startIn: string): Promise<FolderPick> =>
  process.platform === "win32"
    ? windowsPick(startIn)
    : process.platform === "darwin"
      ? macPick(startIn)
      : linuxPick(startIn)

let open: Promise<FolderPick> | null = null

/**
 * Ask for a folder, and answer when the human does.
 *
 * However long that takes — so nothing on a poll may call this, and the caller
 * has to be something a person just pressed.
 */
export function pickFolder(startIn?: string): Promise<FolderPick> {
  // One dialog at a time, with a second caller joining the first rather than
  // opening its own. Two presses of `add` otherwise mean two dialogs, one of
  // them belonging to a request the browser has already given up on: it writes
  // its answer into a dead socket, and its window stays on screen with nothing
  // behind it.
  if (open) return open

  // `resolve` for the separators, not for the absoluteness. Every caller has an
  // absolute path already, but the one they have came from `git rev-parse`,
  // which answers in forward slashes — and the Windows shell parser rejects
  // those, so `SHCreateItemFromParsingName` threw and the dialog silently opened
  // in Documents instead of beside the project it was told about.
  const start = startIn && existsSync(startIn) ? resolve(startIn) : homedir()
  const pick = platformPick(start).finally(() => {
    open = null
  })
  open = pick
  return pick
}
