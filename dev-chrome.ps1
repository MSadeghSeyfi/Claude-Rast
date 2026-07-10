# Launches a dedicated Chrome instance for RTL-extension development.
# - Opens a remote-debugging port (9222) so Claude Code can attach via
#   chrome-devtools-mcp.
# - Uses a separate profile dir so it never touches your normal Chrome.
# - Side-loads THIS repo as an unpacked extension.
#
# Usage: right-click > Run with PowerShell, or:  ./dev-chrome.ps1
# First run: go to chrome://extensions once to confirm the extension loaded,
# then log in to claude.ai. That login/profile persists across runs.

$ext     = $PSScriptRoot
$profile = Join-Path $env:LOCALAPPDATA "claude-rtl-dev-profile"
$chrome  = "C:\Program Files\Google\Chrome\Application\chrome.exe"

& $chrome `
  --remote-debugging-port=9222 `
  --user-data-dir="$profile" `
  --load-extension="$ext" `
  --no-first-run `
  --no-default-browser-check `
  "https://claude.ai/code"
