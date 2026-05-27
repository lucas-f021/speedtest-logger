const speedTest = require('speedtest-net');

async function runSpeedTest() {
  const result = await speedTest({ acceptLicense: true, acceptGdpr: true });

  const toMbps = (bytesPerSec) => bytesPerSec
    ? Math.round((bytesPerSec * 8) / 1_000_000 * 100) / 100
    : null;

  return {
    download: toMbps(result.download?.bandwidth),
    upload: toMbps(result.upload?.bandwidth),
    ping: result.ping?.latency ?? null,
    jitter: result.ping?.jitter ?? null,
    server_name: result.server?.name ?? null,
    server_location: result.server?.location ?? null,
    isp: result.isp ?? null,
    result_url: result.result?.url ?? null,
  };
}

module.exports = { runSpeedTest };
