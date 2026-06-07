# Backlog

Ideas and improvements that aren't scheduled yet. Pull items up into a commit when you're ready
to build them.

## Nice to have

### Capture more of what the speed-test engine already reports
`speedtest-net` (the Ookla Speedtest CLI wrapper) returns ~20 fields per test, but we only store 8
(download, upload, ping, jitter, server name/location, ISP, result URL). Fields available for free in
every result that we currently discard — see the `speedtest-net` README "Return value" section:

- **Packet loss** (`packetLoss`, %) — a real connection-quality metric we don't track today.
- **Data used per test** (`download.bytes` + `upload.bytes`) — sum and surface it; pairs naturally with
  the Schedule picker (e.g. show "≈ X GB/day at this cadence", since each test can use ~0.25–1 GB).
- **Test duration** (`download.elapsed` / `upload.elapsed`, ms).
- **External / WAN IP** (`interface.externalIp`) — spot when the ISP changes your public IP.
- **VPN flag** (`interface.isVpn`) — flag any test that ran over a VPN.
- **Fuller server identity** (`server.country` / `host` / `port` / `ip` / Ookla `id`).

Effort is small per field: add a column to `speed_logs` (`db.js`), map it in `speedtest.js`, and show it
in the table / stats / analytics as desired. Packet loss and data-used are the highest-value picks.
