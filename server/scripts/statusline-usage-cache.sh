# Source from a Claude status-line script after it assigns input=$(cat).
# Save only quota fields. Missing startup data must not erase the last reading.
# The subshell keeps variables/umask isolated from the existing status line.
(
  umask 077
  cache_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  if printf '%s' "$input" | jq -e '.rate_limits | (.five_hour.used_percentage | type == "number") or (.seven_day.used_percentage | type == "number")' >/dev/null 2>&1; then
    cache_tmp=$(mktemp "$cache_dir/.context-village-usage.XXXXXX") || exit 0
    trap 'rm -f "$cache_tmp"' EXIT
    printf '%s' "$input" | jq --argjson now "$(date +%s)" '{observed_at: $now, rate_limits: (.rate_limits | {five_hour, seven_day})}' > "$cache_tmp" &&
      mv -f "$cache_tmp" "$cache_dir/context-village-usage.json"
  fi
) >/dev/null 2>&1
