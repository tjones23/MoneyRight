#!/bin/bash
#
# MoneyRight — production launcher
#
# For the machine that serves the app. Double-click this file in Finder for a
# menu, or run it from a terminal:
#
#   ./run-prod.command start       # serve the last build, to this Mac only
#   ./run-prod.command stop        # stop serving (and stop hosting it anywhere)
#   ./run-prod.command restart     # same build, same hosting
#   ./run-prod.command rebuild     # new production build; restarts if running
#
#   ./run-prod.command tailnet     # host on MoneyRight's own Tailscale node, over HTTPS (+ keep awake)
#   ./run-prod.command tailnet off
#   ./run-prod.command public      # ...and to the internet, via Tailscale Funnel (+ keep awake)
#   ./run-prod.command public off  # back to tailnet-only
#
#   ./run-prod.command status
#   ./run-prod.command logs        # follow the log; any key stops following
#
#   ./run-prod.command setup       # once: let hosting keep a closed-lid Mac awake
#   ./run-prod.command setup --remove
#
# Starting never builds, and building never starts: `rebuild` is how new code
# gets in. Nothing here ever opens a browser.
#
# `public` is the same tailnet address, opened to the internet with Tailscale
# Funnel, as in Outside's launcher: anyone with the link reaches the sign-in
# page, and an account (password plus authenticator or passkey) is all that
# stands in front of the data. It also writes the marker the app's network
# gate needs before it lets a public request in; Funnel found on without it
# is turned off. Unlike Outside there is no `lan`: the server only ever binds
# 127.0.0.1.

set -uo pipefail

# shellcheck source=scripts/run-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/run-common.sh" || exit 1

# Non-zero, with the reason already said, when the port holds something other
# than a production server — a dev server, or one started by hand.
port_is_production() {
  is_running || return 0
  [ "$(current_mode)" = "prod" ] && return 0
  err "Port $PORT is already in use ($(mode_label "$(current_mode)")) — stop that server first."
  return 1
}

prod_start() {
  local mode="${1:-prod}"

  port_is_production || return 1
  if is_running; then
    warn "Production is already running ($(mode_label "$(current_mode)"))."
    print_urls
    return 0
  fi

  launch_server "$mode" || return 1
  sync_awake
  ok "Production running ($(mode_label "$mode"))."
  print_urls
}

prod_stop() {
  stop_server
}

# ---------------------------------------------------------------------------
# Rebuild
#
# `next build` clears .next as it starts, so a server still running from it
# would begin failing requests part-way through. It has to be stopped for the
# build — and if the build then fails, the previous one is put back and served
# again, so a bad deploy costs a couple of minutes rather than the site.
# ---------------------------------------------------------------------------

# Copy the current build aside. dev/ belongs to the dev server and cache/ is
# large and survives `next build` anyway, so neither is copied.
backup_build() {
  rm -rf "$BUILD_BACKUP_DIR"
  [ -f "$DIST_DIR/BUILD_ID" ] || return 1
  mkdir -p "$BUILD_BACKUP_DIR" || return 1

  local item
  for item in "$DIST_DIR"/*; do
    case "${item##*/}" in dev|cache) continue ;; esac
    if ! cp -Rp "$item" "$BUILD_BACKUP_DIR/"; then
      rm -rf "$BUILD_BACKUP_DIR"
      return 1
    fi
  done
  return 0
}

restore_build() {
  [ -f "$BUILD_BACKUP_DIR/BUILD_ID" ] || return 1
  mkdir -p "$DIST_DIR" || return 1

  local item
  for item in "$DIST_DIR"/*; do
    [ -e "$item" ] || continue
    case "${item##*/}" in dev|cache) continue ;; esac
    rm -rf "$item"
  done
  cp -Rp "$BUILD_BACKUP_DIR"/. "$DIST_DIR"/ || return 1
  rm -rf "$BUILD_BACKUP_DIR"
  return 0
}

# After a `git pull` that changed dependencies, the build fails on a missing
# module unless they're installed first.
deps_are_stale() {
  local installed="$REPO_DIR/node_modules/.package-lock.json"
  [ -f "$installed" ] || return 0
  [ "$REPO_DIR/package-lock.json" -nt "$installed" ] || [ "$REPO_DIR/package.json" -nt "$installed" ]
}

prod_rebuild() {
  preflight || return 1

  # The mode to come back in, if production was running.
  local was=""
  if is_running; then
    case "$(current_mode)" in
      prod) was="$(current_mode)" ;;
      # Dev output lives in .next/dev, so building beside it is safe and the
      # dev server can keep running — production just can't start after.
      dev) ;;
      *)
        err "A server these scripts didn't start is on port $PORT — stop it before rebuilding."
        return 1 ;;
    esac
  fi

  local backed_up=""
  backup_build && backed_up=1

  if [ -n "$was" ]; then
    say "${DIM}Stopping production for the build…${RESET}"
    [ -n "$(ts_serve_url)" ] && say "  ${DIM}The tailnet address stays configured and answers with an error until it's back.${RESET}"
    stop_server keep-serve || return 1
  fi

  cd "$REPO_DIR" || return 1
  : > "$BUILD_LOG_FILE"

  if deps_are_stale; then
    say "${DIM}Dependencies changed — running npm install…${RESET}"
    if ! npm install --no-audit --no-fund >>"$BUILD_LOG_FILE" 2>&1; then
      err "npm install failed. Last 20 lines of $BUILD_LOG_FILE:"
      tail -20 "$BUILD_LOG_FILE"
      rebuild_failed "$was" "$backed_up"
      return 1
    fi
  fi

  say "${BOLD}Building for production…${RESET} ${DIM}(this takes a moment)${RESET}"
  if ! npm run build >>"$BUILD_LOG_FILE" 2>&1; then
    err "Build failed. Last 20 lines of $BUILD_LOG_FILE:"
    tail -20 "$BUILD_LOG_FILE"
    rebuild_failed "$was" "$backed_up"
    return 1
  fi

  rm -rf "$BUILD_BACKUP_DIR"
  ok "Build complete."

  if [ -z "$was" ]; then
    if is_running; then
      say "  ${DIM}The dev server still has port $PORT; stop it before starting production.${RESET}"
    else
      say "  ${DIM}Not started — start production to serve it.${RESET}"
    fi
    return 0
  fi

  launch_server "$was" || return 1
  sync_awake
  ok "Production running the new build ($(mode_label "$was"))."
  print_urls
}

# Put the previous build back, and bring production back up on it if it was
# running before the rebuild began.
rebuild_failed() {
  local was="$1" backed_up="$2"

  if [ -z "$backed_up" ]; then
    [ -n "$was" ] && warn "There was no earlier build to go back to — production stays stopped."
    return 0
  fi

  if ! restore_build; then
    err "Couldn't put the previous build back — production stays stopped."
    say "  ${DIM}A copy may remain at $BUILD_BACKUP_DIR.${RESET}"
    return 0
  fi
  ok "Put the previous build back."

  if [ -n "$was" ] && launch_server "$was"; then
    sync_awake
    ok "Production is back up on the previous build ($(mode_label "$was"))."
    print_urls
  fi
}

# ---------------------------------------------------------------------------
# Hosting
#
# The server always binds 127.0.0.1. "Tailnet" is a tailscale serve proxy from
# localhost, switched on and off without touching the server at all.
# ---------------------------------------------------------------------------

# Non-zero, with the reason already said, when MoneyRight's own node can't be
# used at all.
require_tailscale() {
  if ! have_tailscale; then
    err "Tailscale isn't installed."
    say "  ${DIM}brew install tailscale, or get the app from tailscale.com${RESET}"
    return 1
  fi
  if ! have_tailscaled; then
    err "tailscaled isn't installed — MoneyRight needs its own copy to run its own node."
    say "  ${DIM}brew install tailscale (the App Store app and tailscale.com installer don't include tailscaled)${RESET}"
    return 1
  fi
  return 0
}

tailnet_on() {
  require_tailscale || return 1
  port_is_production || return 1

  # Before starting anything: a node that needs a human to log in is worth
  # hearing about while nothing has changed yet.
  ts_connect || return 1

  if ! is_running; then
    launch_server prod || return 1
  fi

  # Pointed at the server only once it answers, so the tailnet URL is never
  # advertising a port that isn't listening yet.
  if [ -z "$(ts_serve_url)" ] && ! ts serve --bg --https="$TS_HTTPS_PORT" "$PORT" >/dev/null 2>&1; then
    err "tailscale serve failed — production is running, but not on the tailnet."
    say "  ${DIM}Run 'tailscale --socket=$TS_SOCKET serve --bg --https=$TS_HTTPS_PORT $PORT' yourself to see why.${RESET}"
    return 1
  fi

  ts_enforce_private || return 1
  sync_awake
  ok "Hosted on the tailnet."
  print_urls
  [ -z "${MONEYRIGHT_ALLOWED_LOGINS:-}" ] && ! grep -qs '^MONEYRIGHT_ALLOWED_LOGINS=.' "$REPO_DIR/.env.local" &&
    say "  ${DIM}Any tailnet member can reach the sign-in page. To narrow that, set MONEYRIGHT_ALLOWED_LOGINS in .env.local.${RESET}"
  return 0
}

tailnet_off() {
  if [ -z "$(ts_serve_url)" ]; then
    rm -f "$PUBLIC_MARKER"
    say "Not hosted on the tailnet."
    return 0
  fi
  ts_unserve || return 1
  ts_daemon_stop
  sync_awake
}

# Funnel is `serve` with public ingress switched on: same proxy, same
# address, just reachable from the internet rather than only the tailnet.
public_on() {
  require_tailscale || return 1
  port_is_production || return 1

  if public_active; then
    ok "Already public."
    print_urls
    return 0
  fi

  ts_connect || return 1

  if ! is_running; then
    launch_server prod || return 1
  fi

  if [ -z "$(ts_serve_url)" ] && ! ts serve --bg --https="$TS_HTTPS_PORT" "$PORT" >/dev/null 2>&1; then
    err "tailscale serve failed — production is running, but not on the tailnet."
    say "  ${DIM}Run 'tailscale --socket=$TS_SOCKET serve --bg --https=$TS_HTTPS_PORT $PORT' yourself to see why.${RESET}"
    return 1
  fi

  # The marker goes down before Funnel comes up, so the first visitor isn't
  # refused — and nothing reaches the app from the internet without Funnel.
  mkdir -p "$STATE_DIR" && : > "$PUBLIC_MARKER" || return 1

  # --yes skips the CLI's own interactive "Continue?" confirmation. But when
  # Funnel has never been approved for this tailnet/node, the CLI doesn't
  # fail — it prints a one-time setup URL and then blocks, polling until
  # someone opens it. Captured into $funnel_out below, that message is
  # invisible and the command never returns on its own, so it's bounded here
  # the same way ts_connect bounds `tailscale up`.
  local funnel_out
  funnel_out="$(mktemp -t moneyright-funnel)" || { rm -f "$PUBLIC_MARKER"; return 1; }
  ts funnel --bg --yes --https="$TS_HTTPS_PORT" "$PORT" >"$funnel_out" 2>&1 &
  local funnel_pid=$! waited=0
  while [ "$waited" -lt 10 ] && kill -0 "$funnel_pid" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
  done

  if kill -0 "$funnel_pid" 2>/dev/null; then
    kill_tree "$funnel_pid" KILL
    rm -f "$PUBLIC_MARKER"
    err "Funnel needs a one-time approval — production is on the tailnet, but not public yet."
    sed 's/^/  /' "$funnel_out"
    say "  ${DIM}Open that link, approve Funnel for this node, then run '$SELF public' again.${RESET}"
    rm -f "$funnel_out"
    return 1
  fi

  wait "$funnel_pid" 2>/dev/null
  local funnel_rc=$?
  if [ "$funnel_rc" -ne 0 ] || ! ts_public; then
    rm -f "$PUBLIC_MARKER"
    err "tailscale funnel failed — production is on the tailnet, but not public."
    sed 's/^/  /' "$funnel_out"
    say "  ${DIM}Funnel may need enabling for this tailnet or node — see https://tailscale.com/kb/1223/funnel${RESET}"
    rm -f "$funnel_out"
    return 1
  fi
  rm -f "$funnel_out"

  sync_awake
  warn "Public: anyone with this link can now reach MoneyRight's sign-in page, not just your tailnet."
  say "  ${DIM}MONEYRIGHT_ALLOWED_LOGINS only narrows tailnet access; from the internet, an account is the only lock.${RESET}"
  ok "Hosted publicly."
  print_urls
}

public_off() {
  if ! ts_public; then
    rm -f "$PUBLIC_MARKER"
    say "Not public."
    return 0
  fi

  # Marker first: the app stops letting the internet in at once, even if
  # Funnel then takes a moment (or fails) to come down.
  rm -f "$PUBLIC_MARKER"
  ts_unfunnel || return 1
  # ts_unfunnel can take the plain tailnet listener down with it on some
  # Tailscale versions; put it back so this always ends up tailnet-only,
  # never fully withdrawn.
  if [ -z "$(ts_serve_url)" ]; then
    ts serve --bg --https="$TS_HTTPS_PORT" "$PORT" >/dev/null 2>&1
  fi
  sync_awake
  ok "No longer public — still on the tailnet."
  print_urls
}

# ---------------------------------------------------------------------------
# Finder double-click: no arguments and a terminal attached, so offer a menu
# and keep the window open afterwards.
# ---------------------------------------------------------------------------

tailnet_toggle() {
  if [ -n "$(ts_serve_url)" ]; then tailnet_off; else tailnet_on; fi
}

public_toggle() {
  if public_active; then public_off; else public_on; fi
}

prod_restart() {
  port_is_production && restart_server prod
}

menu() {
  menu_trap
  # Catch up first: a hold left over from before a reboot is released, and a
  # server already hosting without one gets the offer to set it up.
  sync_lid_hold
  ts_enforce_private
  while true; do
    menu_header "MoneyRight — production"
    say "  1) Start production  ${DIM}(this Mac only, last build)${RESET}"
    say "  2) Stop production"
    say "  3) Restart production"
    say "  4) Rebuild production"
    if [ -n "$(ts_serve_url)" ]; then
      say "  5) Stop hosting on the tailnet"
    else
      say "  5) Host on the tailnet"
    fi
    say "  6) Show logs"
    if public_active; then
      say "  7) Stop public access"
    else
      say "  7) Make public"
    fi
    say "  q) Quit"

    read_choice || return 0
    case "$MENU_CHOICE" in
      1) run_op prod_start prod ;;
      2) run_op prod_stop ;;
      3) run_op prod_restart ;;
      4) run_op prod_rebuild ;;
      5) run_op tailnet_toggle ;;
      6) follow_log "$LOG_FILE" ;;
      7) run_op public_toggle ;;
      q|Q) say "Bye. Anything still running keeps running."; return 0 ;;
      "") ;;
      *) warn "Pick 1–7, or q to quit." ;;
    esac
  done
}

usage() {
  say "Try: start | stop | restart | rebuild | tailnet [off] | public [off] | status | logs | setup"
}

case "${1:-}" in
  start)   run_op prod_start prod ;;
  stop)    run_op prod_stop ;;
  restart) run_op prod_restart ;;
  rebuild) run_op prod_rebuild ;;
  tailnet)
    case "${2:-on}" in
      on)  run_op tailnet_on ;;
      off) run_op tailnet_off ;;
      *)   err "Unknown option: $2"; usage; exit 1 ;;
    esac
    ;;
  public)
    case "${2:-on}" in
      on)  run_op public_on ;;
      off) run_op public_off ;;
      *)   err "Unknown option: $2"; usage; exit 1 ;;
    esac
    ;;
  lan)
    err "MoneyRight is never served to the local network — there is no 'lan'. Use 'public' to reach it from off the tailnet."
    exit 1
    ;;
  status)  status ;;
  logs)    follow_log "$LOG_FILE" ;;
  setup)   shift; sleep_setup "$@" ;;
  ""|menu)
    if [ -t 0 ]; then
      menu
    else
      status
    fi
    ;;
  -h|--help|help)
    # Print the header comment block, stopping at the first line of code.
    awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
    ;;
  *)
    err "Unknown command: $1"
    usage
    exit 1
    ;;
esac
