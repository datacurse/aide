/**
 * The Node-only half of the protocol package: `@aide/protocol/node`.
 *
 * Everything here touches `node:path`, `node:os` or gray-matter, so importing it
 * from the browser fails at runtime with no useful error — a blank page.
 *
 * The main entry (`@aide/protocol`) is therefore browser-safe BY CONSTRUCTION:
 * it exports wire types, status vocabularies and pure helpers, and nothing that
 * reaches for the filesystem. The daemon imports from both; the web imports only
 * from the barrel, and cannot accidentally pull Node in because there is nothing
 * Node-shaped there to pull.
 */
export * from "./paths.js"
export * from "./task-io.js"
export * from "./project-io.js"
