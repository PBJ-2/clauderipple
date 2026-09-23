// The one version string the router, CLI and app compare against each other.
//
// Packaged apps ship only `packages/*/src`, so nothing at runtime can read a package.json. The
// constant lives here and packages/router/test/version.test.ts fails the build when it drifts
// from the manifests. Until 0.1.1 the router and the CLI each carried their own literal, and both
// still said "0.1.0" in the 0.1.1 release: after an update nobody could tell which router was
// running, and the tray app had nothing to compare (2026-09-15, reported from a Windows install).
export const VERSION = "0.3.0";
