#!/bin/sh
# ClaudeRipple installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/PBJ-2/clauderipple/main/scripts/install.sh | sh
#
# Installing from npm needs npm, which needs Node, which is the one thing a first-time user is not
# guaranteed to have. So this script brings its own: it uses a Node 24+ already on PATH when there
# is one, and otherwise downloads the official build into ClaudeRipple's own directory. Nothing
# here needs administrator rights, and nothing is installed outside the prefix below.
#
# Options (environment):
#   CLAUDERIPPLE_PREFIX    where to install            (default: $HOME/.clauderipple)
#   CLAUDERIPPLE_PACKAGE   what to install             (default: clauderipple, from npm)
#   CLAUDERIPPLE_NO_SETUP  1 = install only, no setup  (default: run `clauderipple install`)
set -eu

PREFIX="${CLAUDERIPPLE_PREFIX:-$HOME/.clauderipple}"
PACKAGE="${CLAUDERIPPLE_PACKAGE:-clauderipple}"
NODE_MAJOR=24
# Resolved from nodejs.org at install time so this script does not carry a version that goes stale;
# the pin is only what to use when the release index cannot be reached.
NODE_FALLBACK="v24.21.0"
RUNTIME="$PREFIX/runtime"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- the Node to install with -------------------------------------------------------------------

node_major() { "$1" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || true; }

find_node() {
  command -v node >/dev/null 2>&1 || return 1
  major="$(node_major node)"
  [ -n "$major" ] && [ "$major" -ge "$NODE_MAJOR" ] 2>/dev/null || return 1
  command -v node
}

download_node() {
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die "unsupported system: $(uname -s). Install Node $NODE_MAJOR+ yourself, then: npm install -g clauderipple" ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) die "unsupported processor: $(uname -m). Install Node $NODE_MAJOR+ yourself, then: npm install -g clauderipple" ;;
  esac
  version="$(curl -fsSL https://nodejs.org/dist/index.json 2>/dev/null |
    tr ',' '\n' | grep -o '"v24\.[0-9]*\.[0-9]*"' | head -1 | tr -d '"')"
  [ -n "$version" ] || version="$NODE_FALLBACK"
  name="node-$version-$os-$arch"
  base="https://nodejs.org/dist/$version"
  tmp="$(mktemp -d)"
  say "Downloading Node $version ($os-$arch)…"
  curl -fsSL "$base/$name.tar.gz" -o "$tmp/node.tar.gz" || die "could not download Node from $base"
  # The download is verified against the release's own checksum file before anything is unpacked.
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || die "could not download the Node checksums"
  expected="$(grep " $name.tar.gz\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
  [ -n "$expected" ] || die "no checksum published for $name.tar.gz"
  if command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$tmp/node.tar.gz" | cut -d' ' -f1)"
  elif command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/node.tar.gz" | cut -d' ' -f1)"
  else die "neither shasum nor sha256sum is available to verify the download"; fi
  [ "$actual" = "$expected" ] || die "the Node download does not match its published checksum"
  rm -rf "$RUNTIME"
  mkdir -p "$RUNTIME"
  tar -xzf "$tmp/node.tar.gz" -C "$RUNTIME" --strip-components 1
  rm -rf "$tmp"
}

NODE="$(find_node || true)"
if [ -n "${NODE:-}" ]; then
  say "Using Node $("$NODE" -v) at $NODE"
elif [ -x "$RUNTIME/bin/node" ] && [ "$(node_major "$RUNTIME/bin/node")" -ge "$NODE_MAJOR" ] 2>/dev/null; then
  NODE="$RUNTIME/bin/node"
  say "Using the Node ClaudeRipple installed earlier ($("$NODE" -v))"
else
  # download_node reports progress as it goes, so it leaves the result where both of us know it is
  # rather than on stdout, which would arrive mixed in with those lines.
  download_node
  NODE="$RUNTIME/bin/node"
  [ -x "$NODE" ] || die "unpacked Node but found no executable at $NODE"
  say "Installed Node $("$NODE" -v) in $RUNTIME"
fi

NPM_CLI="$(dirname "$NODE")/../lib/node_modules/npm/bin/npm-cli.js"
[ -f "$NPM_CLI" ] || NPM_CLI="$(dirname "$(command -v npm 2>/dev/null || true)")/../lib/node_modules/npm/bin/npm-cli.js"
[ -f "$NPM_CLI" ] || die "found Node at $NODE but no npm next to it"

# --- the package --------------------------------------------------------------------------------
# Installed under our own prefix rather than the Node installation's: no permission prompt, no
# EACCES on a Node that root owns, and uninstalling is removing one directory.

say "Installing $PACKAGE…"
"$NODE" "$NPM_CLI" install --global --prefix "$PREFIX" --loglevel error "$PACKAGE"

BIN="$PREFIX/bin"
[ -x "$BIN/clauderipple" ] || die "npm installed $PACKAGE but left no command in $BIN"

# npm's own command is a link to a file whose shebang is `env node`. That resolves to nothing when
# the Node we just downloaded is the only one on this machine, so the command would install fine
# and then fail to start. Replaced with a wrapper that names the interpreter we chose.
case "$NODE" in
  "$RUNTIME"/*)
    ENTRY="$PREFIX/lib/node_modules/clauderipple/bin/clauderipple.js"
    [ -f "$ENTRY" ] || die "the installed package has no entry point at $ENTRY"
    rm -f "$BIN/clauderipple"
    printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE" "$ENTRY" > "$BIN/clauderipple"
    chmod +x "$BIN/clauderipple"
    ;;
esac

# --- PATH ---------------------------------------------------------------------------------------

on_path() {
  case ":$PATH:" in *":$BIN:"*) return 0 ;; *) return 1 ;; esac
}

profile_file() {
  case "${SHELL:-}" in
    */zsh) printf '%s' "$HOME/.zshrc" ;;
    */bash) [ -f "$HOME/.bash_profile" ] && printf '%s' "$HOME/.bash_profile" || printf '%s' "$HOME/.bashrc" ;;
    *) printf '%s' "$HOME/.profile" ;;
  esac
}

if on_path; then
  :
else
  profile="$(profile_file)"
  line="export PATH=\"$BIN:\$PATH\""
  if [ -f "$profile" ] && grep -Fq "$BIN" "$profile"; then
    say "$BIN is already in $profile; open a new terminal to pick it up."
  else
    printf '\n# ClaudeRipple\n%s\n' "$line" >> "$profile"
    say "Added $BIN to your PATH in $profile."
  fi
  PATH="$BIN:$PATH"
  export PATH
fi

# --- setup --------------------------------------------------------------------------------------

if [ "${CLAUDERIPPLE_NO_SETUP:-}" = "1" ]; then
  say ""
  say "Installed. Finish with: clauderipple install"
  exit 0
fi

say ""
"$BIN/clauderipple" install
say ""
say "Open the dashboard with: clauderipple ui"
