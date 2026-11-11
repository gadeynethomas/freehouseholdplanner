// Nearby sync PoC UI (K12): shows the phone's state and what the Kotlin side logged.
const { invoke } = window.__TAURI__.core;

const call = (command, args) => invoke('nearby', { command, args });
const els = {
  state: document.getElementById('state'),
  error: document.getElementById('error'),
  summary: document.getElementById('summary'),
  events: document.getElementById('events'),
  toggles: {
    service: { input: document.getElementById('service'), command: 'setService' },
    backgroundScan: { input: document.getElementById('backgroundScan'), command: 'setBackgroundScan' },
    aware: { input: document.getElementById('aware'), command: 'setAware' },
  },
};

const time = (ms) => new Date(ms).toLocaleTimeString('nl-BE');
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

const PERMISSION_NAMES = {
  scan: 'scannen',
  advertise: 'uitzenden',
  connect: 'verbinden',
  nearbyWifi: 'wifi in de buurt',
  notifications: 'meldingen',
  localNetwork: 'lokaal netwerk',
};

function describe(event) {
  switch (event.kind) {
    case 'edit':
      return `wijziging ${event.id} gemaakt (${kb(event.size)})`;
    case 'received':
      return `wijziging ${event.id} ontvangen via ${event.transport} na ${seconds(event.latencyMs)}`;
    case 'sync':
      return `sync via ${event.transport} (${event.role}): ${event.sent} weg, ${event.received} binnen, ` +
        `verbinden ${seconds(event.connectMs)}, overdracht ${seconds(event.transferMs)}, ` +
        `${kb(event.bytesOut + event.bytesIn)}`;
    case 'sync-failed':
      return `sync via ${event.transport} (${event.role}) mislukt: ${event.error}`;
    case 'seen':
      return `gsm gezien via ${event.transport}${event.source ? ` (${event.source})` : ''}`;
    case 'wakes':
      return `achtergrondscan: ${event.wakes}× gewekt, ${event.results} resultaten`;
    case 'advertising':
      return `zendt uit (${event.edits} wijzigingen)`;
    case 'service':
      return `dienst ${event.on ? 'aan' : 'uit'}`;
    default: {
      const { t, kind, battery, ...rest } = event;
      const details = Object.entries(rest).map(([key, value]) => `${key}=${value}`).join(', ');
      return details ? `${kind}: ${details}` : kind;
    }
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(events) {
  const rows = [];
  for (const transport of ['ble', 'aware']) {
    const received = events.filter((e) => e.kind === 'received' && e.transport === transport);
    if (received.length === 0) continue;
    const latencies = received.map((e) => e.latencyMs);
    rows.push([`Ontvangen via ${transport}`, `${received.length}, mediaan ${seconds(median(latencies))}, ` +
      `max ${seconds(Math.max(...latencies))}`]);
    const syncs = events.filter((e) => e.kind === 'sync' && e.transport === transport && e.bytesIn > 50_000);
    if (syncs.length > 0) {
      const rates = syncs.map((e) => e.bytesIn / 1024 / Math.max(e.transferMs / 1000, 0.001));
      rows.push([`Snelheid ${transport} (grote)`, `mediaan ${Math.round(median(rates))} KB/s`]);
    }
  }
  const failed = events.filter((e) => e.kind === 'sync-failed').length;
  rows.push(['Mislukte syncs', String(failed)]);
  return rows;
}

function render(status) {
  const missing = Object.entries(status.permissions)
    .filter(([, granted]) => !granted)
    .map(([name]) => PERMISSION_NAMES[name] ?? name);
  els.state.textContent = [
    `Apparaat ${status.deviceId}`,
    `${status.edits} wijzigingen (${status.digest})`,
    status.bluetooth ? 'Bluetooth aan' : 'Bluetooth UIT',
    status.awareSupported ? (status.awareAvailable ? 'Wi-Fi Aware beschikbaar' : 'Wi-Fi Aware nu niet beschikbaar')
      : 'geen Wi-Fi Aware',
    missing.length ? `ontbreekt: ${missing.join(', ')}` : 'alle toestemmingen',
  ].join(' · ');

  for (const [key, toggle] of Object.entries(els.toggles)) {
    if (document.activeElement !== toggle.input) toggle.input.checked = status[key];
  }

  els.summary.replaceChildren(
    ...summarize(status.events).flatMap(([term, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      return [dt, dd];
    }),
  );

  els.events.replaceChildren(
    ...status.events.slice(-60).reverse().map((event) => {
      const row = document.createElement('tr');
      for (const text of [time(event.t), describe(event), `${event.battery} %`]) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      return row;
    }),
  );
}

async function run(command, args) {
  els.error.textContent = '';
  try {
    await call(command, args);
  } catch (error) {
    els.error.textContent = String(error);
  }
  await refresh();
}

async function refresh() {
  try {
    render(await call('status'));
  } catch (error) {
    els.error.textContent = String(error);
  }
}

for (const button of document.querySelectorAll('button[data-size]')) {
  button.addEventListener('click', () => run('edit', { size: Number(button.dataset.size) }));
}
for (const toggle of Object.values(els.toggles)) {
  toggle.input.addEventListener('change', () => run(toggle.command, { enabled: toggle.input.checked }));
}
document.getElementById('permissions').addEventListener('click', () => run('askPermissions'));
document.getElementById('clear').addEventListener('click', () => run('clearLog'));

refresh();
setInterval(refresh, 1000);
