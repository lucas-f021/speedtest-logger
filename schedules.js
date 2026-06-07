// Preset run frequencies for the scheduled speed test. Each maps a short key to a
// human label (shown in the sidebar dropdown) and the cron expression node-cron runs.
// Mirrors the registry shape of servers.js.
const SCHEDULE_PRESETS = [
  { key: '30m', label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { key: '1h',  label: 'Every hour',       cron: '0 * * * *' },
  { key: '2h',  label: 'Every 2 hours',    cron: '0 */2 * * *' },
  { key: '6h',  label: 'Every 6 hours',    cron: '0 */6 * * *' },
  { key: '12h', label: 'Every 12 hours',   cron: '0 */12 * * *' },
  { key: '1d',  label: 'Once a day',       cron: '0 0 * * *' },
];

const DEFAULT_SCHEDULE_KEY = '1h'; // hourly — matches the app's original fixed behavior

function getPreset(key) {
  return SCHEDULE_PRESETS.find(p => p.key === key) || null;
}

function getCronForKey(key) {
  const preset = getPreset(key);
  return preset ? preset.cron : null;
}

function isValidScheduleKey(key) {
  return SCHEDULE_PRESETS.some(p => p.key === key);
}

// The options shown in the sidebar dropdown.
function listScheduleOptions() {
  return SCHEDULE_PRESETS.map(p => ({ key: p.key, label: p.label }));
}

module.exports = {
  SCHEDULE_PRESETS,
  DEFAULT_SCHEDULE_KEY,
  getPreset,
  getCronForKey,
  isValidScheduleKey,
  listScheduleOptions,
};
