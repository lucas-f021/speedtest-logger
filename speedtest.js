const speedTest = require('speedtest-net');

async function runSpeedTest(serverId) {
  const options = { acceptLicense: true, acceptGdpr: true };
  if (serverId) options.serverId = serverId;
  const result = await speedTest(options);

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
    // Extra Ookla fields (every key always present so insertLog's named binding never throws).
    packet_loss: result.packetLoss ?? null,
    bytes_downloaded: result.download?.bytes ?? null,
    bytes_uploaded: result.upload?.bytes ?? null,
    elapsed_download: result.download?.elapsed ?? null,
    elapsed_upload: result.upload?.elapsed ?? null,
    external_ip: result.interface?.externalIp ?? null,
    is_vpn: result.interface?.isVpn ? 1 : 0,
    server_id: result.server?.id != null ? String(result.server.id) : null,
    server_host: result.server?.host ?? null,
    server_port: result.server?.port ?? null,
    server_ip: result.server?.ip ?? null,
    server_country: result.server?.country ?? null,
  };
}

module.exports = { runSpeedTest };
