const net = require('net');

// The three vetted local Ookla servers the user can pin to.
// Hosts/ports/ids come from `speedtest -L -f json` and are used for the cheap
// TCP-latency probe behind the "Fastest" option.
// NOTE: Ookla decommissions/renumbers servers over time. If a test fails with
// "NoServersException", re-run `speedtest -L -f json` and refresh the ids/hosts below.
// (Ookla retired the old Comcast/Boston id 1774 in June 2026 → replaced with Norwood Light.)
const SERVERS = [
  { key: '4920',  id: 4920,  name: 'Norwood Light', location: 'Norwood, MA',    host: 'speedtest.norwoodlight.com',      port: 8080 },
  { key: '74553', id: 74553, name: 'GONETSPEED',    location: 'Providence, RI', host: 'prvdrips-ookla01.gonetspeed.com', port: 8080 },
  { key: '29122', id: 29122, name: 'i3 Broadband',  location: 'Warren, RI',     host: 'speedtest.fullchannel.net',       port: 8080 },
];

const DEFAULT_SERVER_KEY = '4920'; // Norwood Light — factory default on first run
const FASTEST_KEY = 'fastest';

function getServerByKey(key) {
  return SERVERS.find(s => s.key === key) || null;
}

function isValidSelection(key) {
  return key === FASTEST_KEY || SERVERS.some(s => s.key === key);
}

// The options shown in the sidebar (three servers + the Fastest auto-pick).
function listOptions() {
  return [
    ...SERVERS.map(s => ({ key: s.key, name: s.name, location: s.location })),
    { key: FASTEST_KEY, name: 'Fastest', location: 'Auto-pick lowest latency' },
  ];
}

// Measure a single TCP-connect round-trip to host:port in milliseconds.
// Resolves to Infinity on timeout/error so unreachable servers sort last.
function tcpPing(host, port, timeout = 3000) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    const start = process.hrtime.bigint();
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(Number(process.hrtime.bigint() - start) / 1e6));
    socket.once('timeout', () => finish(Infinity));
    socket.once('error', () => finish(Infinity));
    socket.connect(port, host);
  });
}

// Probe all three servers a few times each and return the lowest-latency one.
// Falls back to the default server if every probe fails.
async function pickFastestServer(attempts = 3) {
  const measured = await Promise.all(SERVERS.map(async server => {
    let best = Infinity;
    for (let i = 0; i < attempts; i++) {
      const ms = await tcpPing(server.host, server.port);
      if (ms < best) best = ms;
    }
    return { server, latency: best };
  }));
  measured.sort((a, b) => a.latency - b.latency);
  const winner = measured[0];
  if (!winner || winner.latency === Infinity) {
    return getServerByKey(DEFAULT_SERVER_KEY);
  }
  return winner.server;
}

module.exports = {
  SERVERS,
  DEFAULT_SERVER_KEY,
  FASTEST_KEY,
  getServerByKey,
  isValidSelection,
  listOptions,
  pickFastestServer,
};
