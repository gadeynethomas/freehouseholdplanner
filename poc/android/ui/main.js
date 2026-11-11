// Probe UI: shows what the Rust side received, and marks when the app goes to the background.
const { invoke } = window.__TAURI__.core;

const els = {
  connection: document.getElementById('connection'),
  relayForm: document.getElementById('relay-form'),
  relay: document.getElementById('relay'),
  service: document.getElementById('service'),
  serviceError: document.getElementById('service-error'),
  summary: document.getElementById('summary'),
  events: document.getElementById('events'),
  logPath: document.getElementById('log-path'),
};

const time = (ms) => new Date(ms).toLocaleTimeString('nl-BE');
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

function describe(event) {
  if (event.kind === 'ping') return `ping ${event.seq}`;
  if (event.kind === 'mark') return `— ${event.note}`;
  if (event.kind === 'connected') return 'verbonden';
  if (event.kind === 'disconnected') return `verbinding weg (${event.note ?? ''})`;
  return event.note ?? event.kind;
}

function summarize(events) {
  const pings = events.filter((event) => event.kind === 'ping');
  if (pings.length === 0) return [['Pings ontvangen', '0']];
  const delays = pings.map((ping) => ping.receivedAt - ping.sentAt);
  const seqs = pings.map((ping) => ping.seq);
  const expected = Math.max(...seqs) - Math.min(...seqs) + 1;
  const late = delays.filter((delay) => delay > 15_000).length;
  return [
    ['Pings ontvangen', `${pings.length} van ${expected}`],
    ['Grootste vertraging', seconds(Math.max(...delays))],
    ['Meer dan 15 s te laat', String(late)],
    ['Verbroken', String(events.filter((event) => event.kind === 'disconnected').length)],
  ];
}

function render(status) {
  els.connection.textContent = status.connected ? `Verbonden met ${status.relay}` : `Niet verbonden (${status.relay})`;
  els.connection.className = status.connected ? 'ok' : 'bad';
  if (document.activeElement !== els.relay) els.relay.value = status.relay;
  els.logPath.textContent = status.logPath;

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
    ...status.events.slice(-40).reverse().map((event) => {
      const row = document.createElement('tr');
      const delay = event.kind === 'ping' ? seconds(event.receivedAt - event.sentAt) : '';
      for (const text of [time(event.receivedAt), describe(event), delay]) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      return row;
    }),
  );
}

async function refresh() {
  try {
    render(await invoke('status'));
  } catch (error) {
    els.connection.textContent = `Fout: ${error}`;
    els.connection.className = 'bad';
  }
}

els.relayForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await invoke('set_relay', { relay: els.relay.value.trim() });
  await refresh();
});

els.service.addEventListener('change', async () => {
  els.serviceError.textContent = '';
  try {
    await invoke('set_foreground_service', { enabled: els.service.checked });
  } catch (error) {
    els.serviceError.textContent = String(error);
    els.service.checked = !els.service.checked;
  }
});

document.addEventListener('visibilitychange', () => {
  invoke('mark', { note: document.hidden ? 'app naar achtergrond' : 'app terug op voorgrond' });
});

refresh();
setInterval(refresh, 1000);
