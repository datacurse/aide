/**
 * The shared wire surface, and deliberately BROWSER-SAFE.
 *
 * Nothing exported from here may import `node:*` or a Node-only library. The web
 * bundle imports this barrel, and the failure mode when that rule is broken is
 * uniquely unhelpful: Vite happily resolves `node:os` at dev time, the browser
 * refuses it at runtime, React never mounts, and you get a blank white page with
 * nothing in the terminal. It cost an afternoon once.
 *
 * Anything that needs the filesystem lives in `@aide/protocol/node`.
 */
export * from "./names.js"
export * from "./activity.js"
export * from "./card.js"
export * from "./events.js"
export * from "./chatlist.js"
export * from "./project.js"
export * from "./git.js"
export * from "./health.js"
export * from "./session.js"
export * from "./ssh.js"
export * from "./summary.js"
export * from "./usage.js"
