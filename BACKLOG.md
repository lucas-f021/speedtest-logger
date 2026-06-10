# Backlog

Ideas and improvements that aren't scheduled yet. Pull items up into a commit when you're ready
to build them.

## Nice to have

### Resurrect retired Trends visuals once there's more history
The v0.4.0 Trends experiments (delta badges vs the prior period, distribution boxplots, the
GitHub-style **daily download calendar heatmap**) were replaced by the v0.5.0 month report.
With 6+ months of data some could return as companions to it — the heatmap is the strongest
candidate, and its backend (`GET /api/daily`) is still in place, just unused by the UI.

## Done

### Capture more of what the speed-test engine already reports — ✅ v0.3.0
Now capturing all six previously-discarded field groups into `speed_logs` (`packet_loss`,
`bytes_downloaded`/`bytes_uploaded`, `elapsed_download`/`elapsed_upload`, `external_ip`, `is_vpn`,
and fuller server identity: `server_id`/`host`/`port`/`ip`/`country`). Packet loss and data-used
are surfaced as stat cards + log-table columns; the rest live in the Server cell's hover tooltip.

Possible follow-ups (not yet queued):
- Roll packet-loss / data-used into the weekly/monthly **snapshots** + Trends page.
- A "≈ X GB/day at this cadence" projection tied to the Schedule picker.
