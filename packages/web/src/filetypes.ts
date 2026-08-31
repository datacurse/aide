import {
  Article,
  Brush,
  CodeGlyph,
  CodeTag,
  Database,
  File,
  Gear,
  Image,
  Package,
  Terminal,
} from "./icons.js"

/**
 * What a file looks like in the tree: an icon, and a colour.
 *
 * Drawn here rather than installed. A real icon pack — Seti, Material,
 * vscode-icons — is a few thousand SVGs plus a font or a sprite sheet, and this
 * package has four dependencies on purpose; `icons.tsx` already exists because
 * pulling in nine thousand Phosphor components to draw a dozen shapes was the
 * same trade and was refused. These are Phosphor paths, copied verbatim like
 * every other icon in that file, so the cost is the eight shapes actually used.
 *
 * Eight, and not one per language, because of what survives 12px in a 16rem
 * column. A pack spends thousands of glyphs distinguishing TypeScript from
 * JavaScript from CoffeeScript; at the size these render, those are three
 * blue-ish smudges told apart by their position in the list. What the eye can
 * actually resolve is the SHAPE class — is this code, configuration, prose, a
 * picture — so there is one distinguishable icon per answer, and the language
 * is carried by colour instead.
 *
 * The colours come from the syntax palette already in `index.css`, so nothing
 * here is a new language to learn if you have looked at the editor: TypeScript
 * takes the blue VS Code gives types, JavaScript the yellow it gives functions.
 */

/** A React component taking `className` — the shape every icon in `icons.tsx` has. */
type IconComponent = (props: { className?: string }) => React.ReactElement

/** A file's kind: which glyph, and in which colour. */
export interface FileLook {
  Icon: IconComponent
  /** A Tailwind text colour from the theme — never a hex. */
  tone: string
}

/**
 * Whole filenames, checked before extensions.
 *
 * These are the files you look for by name rather than by type, and several have
 * an extension that would file them somewhere useless: `package.json` is not
 * interesting as JSON, and a `Dockerfile` has no extension at all. Lowercase
 * keys, matched against a lowercased name, so `README.md` and `readme.md` are
 * the same file to this.
 */
const BY_NAME: Record<string, FileLook> = {
  "package.json": { Icon: Package, tone: "text-syn-func" },
  "pnpm-lock.yaml": { Icon: Package, tone: "text-fg-dim" },
  "package-lock.json": { Icon: Package, tone: "text-fg-dim" },
  "pnpm-workspace.yaml": { Icon: Package, tone: "text-syn-func" },
  dockerfile: { Icon: Package, tone: "text-info" },
  ".dockerignore": { Icon: Gear, tone: "text-fg-dim" },
  ".gitignore": { Icon: Gear, tone: "text-fg-dim" },
  ".gitattributes": { Icon: Gear, tone: "text-fg-dim" },
  ".editorconfig": { Icon: Gear, tone: "text-fg-dim" },
  ".env": { Icon: Gear, tone: "text-warn" },
  ".env.example": { Icon: Gear, tone: "text-fg-dim" },
  "claude.md": { Icon: Article, tone: "text-syn-keyword" },
  "readme.md": { Icon: Article, tone: "text-syn-comment" },
  license: { Icon: Article, tone: "text-fg-dim" },
}

/**
 * Extensions, lowercased and without the dot.
 *
 * Grouped by what they ARE rather than alphabetically, because the grouping is
 * the feature: everything that compiles together shares a colour and reads as
 * one band down the column, and a new entry belongs in the group whose shape and
 * colour it should share.
 */
const BY_EXTENSION: Record<string, FileLook> = {
  // TypeScript — the blue VS Code gives a type.
  ts: { Icon: CodeGlyph, tone: "text-syn-var" },
  tsx: { Icon: CodeGlyph, tone: "text-syn-var" },
  mts: { Icon: CodeGlyph, tone: "text-syn-var" },
  cts: { Icon: CodeGlyph, tone: "text-syn-var" },
  "d.ts": { Icon: CodeGlyph, tone: "text-syn-type" },

  // JavaScript — the yellow it gives a function.
  js: { Icon: CodeGlyph, tone: "text-syn-func" },
  jsx: { Icon: CodeGlyph, tone: "text-syn-func" },
  mjs: { Icon: CodeGlyph, tone: "text-syn-func" },
  cjs: { Icon: CodeGlyph, tone: "text-syn-func" },

  // Data and config. Deliberately quiet: these are the files you scroll PAST
  // looking for code, so they must not be the loudest thing in the column.
  json: { Icon: Gear, tone: "text-syn-number" },
  jsonc: { Icon: Gear, tone: "text-syn-number" },
  yaml: { Icon: Gear, tone: "text-syn-number" },
  yml: { Icon: Gear, tone: "text-syn-number" },
  toml: { Icon: Gear, tone: "text-syn-number" },
  ini: { Icon: Gear, tone: "text-fg-dim" },
  env: { Icon: Gear, tone: "text-warn" },

  // Markup and style.
  html: { Icon: CodeTag, tone: "text-err" },
  xml: { Icon: CodeTag, tone: "text-syn-number" },
  css: { Icon: Brush, tone: "text-info" },
  scss: { Icon: Brush, tone: "text-syn-keyword" },

  // Prose.
  md: { Icon: Article, tone: "text-syn-comment" },
  mdx: { Icon: Article, tone: "text-syn-comment" },
  txt: { Icon: Article, tone: "text-fg-dim" },

  // Other languages, on the chance a project here is not TypeScript.
  py: { Icon: CodeGlyph, tone: "text-syn-type" },
  rs: { Icon: CodeGlyph, tone: "text-warn" },
  go: { Icon: CodeGlyph, tone: "text-info" },
  sh: { Icon: Terminal, tone: "text-syn-comment" },
  sql: { Icon: Database, tone: "text-syn-type" },
  csv: { Icon: Database, tone: "text-syn-number" },

  // Images. One shape for all of them: which format a picture is in is not what
  // you are looking for when you are looking for the picture.
  png: { Icon: Image, tone: "text-syn-keyword" },
  jpg: { Icon: Image, tone: "text-syn-keyword" },
  jpeg: { Icon: Image, tone: "text-syn-keyword" },
  gif: { Icon: Image, tone: "text-syn-keyword" },
  svg: { Icon: Image, tone: "text-syn-keyword" },
  ico: { Icon: Image, tone: "text-syn-keyword" },
  webp: { Icon: Image, tone: "text-syn-keyword" },
}

/** Anything unrecognised: the plain page, dimmed. */
const PLAIN: FileLook = { Icon: File, tone: "text-fg-dim" }

/**
 * How to draw one filename.
 *
 * `d.ts` is why the extension is not simply "after the last dot": a declaration
 * file is a different kind of thing from the `.ts` it sits beside, and taking
 * only the final segment files it as ordinary TypeScript. So the longest
 * matching suffix wins, which costs one extra lookup and gets that one right.
 */
export function lookOf(name: string): FileLook {
  const lower = name.toLowerCase()

  const named = BY_NAME[lower]
  if (named) return named

  // A dotfile with no other dot — `.prettierrc` — is a name, not an extension.
  // Without this its "extension" is the whole name minus the leading dot, which
  // matches nothing and falls through to the plain page rather than the gear it
  // obviously is.
  const firstDot = lower.indexOf(".")
  if (firstDot === 0 && lower.indexOf(".", 1) === -1) {
    return { Icon: Gear, tone: "text-fg-dim" }
  }

  // Two-segment suffixes first, for `d.ts` and anything like it later.
  const parts = lower.split(".")
  if (parts.length > 2) {
    const long = BY_EXTENSION[parts.slice(-2).join(".")]
    if (long) return long
  }
  return BY_EXTENSION[parts[parts.length - 1] ?? ""] ?? PLAIN
}
