// Root package entrypoint for OpenCode V2 directory-plugin discovery.
// Keep the implementation in src so package consumers and local directory
// plugins resolve through the same dual-shape export.
export { default } from "./src/index.ts";
