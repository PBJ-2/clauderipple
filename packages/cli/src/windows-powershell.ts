// Environment for every powershell.exe (Windows PowerShell 5.1) the CLI and router start.
//
// PowerShell 7 puts its own module directories at the front of PSModulePath. pwsh strips them
// when it starts powershell.exe itself, but not when another process sits in between: from a pwsh
// terminal the chain pwsh → node → powershell.exe hands 5.1 the PowerShell 7 copy of
// Microsoft.PowerShell.Security, which fails to load, and the Cert: drive goes with it.
// `picker on` then stopped at "Cannot find drive 'Cert'" and `status` read a trusted CA as
// untrusted (measured on Windows 11 with PowerShell 7.6.6, issue #35). Without the variable,
// Windows PowerShell rebuilds its own default from the registry.

/** process.env minus PSModulePath, matched without regard to case as Windows does. */
export function windowsPowerShellEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "psmodulepath"));
}
