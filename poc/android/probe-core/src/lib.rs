//! Keeps a TCP connection to the relay and records when each ping from the laptop arrives.
//!
//! Wire format matches `poc/sync/src/relay.ts`: frames are a u32 big-endian length and the bytes.
//! The first frame names the room. Pings are JSON: `{"seq": n, "sentAt": unix_ms}`.

use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Shared with the sender (`sender/sender.ts`): 32 bytes, padded with zeros.
const ROOM: &[u8; 32] = b"fhp-probe-room-v1\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0";
const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_EVENTS_IN_MEMORY: usize = 2000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    kind: &'static str,
    received_at: u64,
    seq: Option<u64>,
    sent_at: Option<u64>,
    note: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    relay: String,
    connected: bool,
    log_path: String,
    events: Vec<Event>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ping {
    seq: u64,
    sent_at: u64,
}

struct Inner {
    relay: String,
    connected: bool,
    events: Vec<Event>,
}

/// The probe's state, shared between the connection thread and the commands.
#[derive(Clone)]
pub struct Probe {
    inner: Arc<Mutex<Inner>>,
    log_path: PathBuf,
}

impl Probe {
    pub fn new(relay: String, log_path: PathBuf) -> Self {
        let inner = Inner {
            relay,
            connected: false,
            events: Vec::new(),
        };
        Self {
            inner: Arc::new(Mutex::new(inner)),
            log_path,
        }
    }

    pub fn start(&self) {
        let probe = self.clone();
        thread::spawn(move || probe.run());
    }

    pub fn status(&self) -> Status {
        let inner = self.lock();
        Status {
            relay: inner.relay.clone(),
            connected: inner.connected,
            log_path: self.log_path.display().to_string(),
            events: inner.events.clone(),
        }
    }

    /// Takes effect on the next (re)connect.
    pub fn set_relay(&self, relay: String) {
        self.lock().relay = relay;
        self.record("mark", None, None, Some("relay changed".into()));
    }

    /// Records a lifecycle marker from the UI, e.g. "hidden" or "visible".
    pub fn mark(&self, note: String) {
        self.record("mark", None, None, Some(note));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn run(&self) {
        let mut backoff = Duration::from_secs(1);
        loop {
            let relay = self.lock().relay.clone();
            match self.session(&relay) {
                Ok(()) => backoff = Duration::from_secs(1),
                Err(error) => {
                    self.set_connected(false, Some(error.to_string()));
                    thread::sleep(backoff);
                    backoff = (backoff * 2).min(Duration::from_secs(30));
                }
            }
        }
    }

    /// One connection: join the room, then read pings until the connection breaks.
    fn session(&self, relay: &str) -> io::Result<()> {
        let address = resolve(relay)?;
        let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)?;
        stream.set_nodelay(true)?;
        write_frame(&mut stream, ROOM)?;
        self.set_connected(true, Some(format!("connected to {relay}")));
        loop {
            let frame = read_frame(&mut stream)?;
            match serde_json::from_slice::<Ping>(&frame) {
                Ok(ping) => self.record("ping", Some(ping.seq), Some(ping.sent_at), None),
                Err(_) => self.record("error", None, None, Some("unreadable ping".into())),
            }
        }
    }

    fn set_connected(&self, connected: bool, note: Option<String>) {
        self.lock().connected = connected;
        let kind = if connected {
            "connected"
        } else {
            "disconnected"
        };
        self.record(kind, None, None, note);
    }

    fn record(
        &self,
        kind: &'static str,
        seq: Option<u64>,
        sent_at: Option<u64>,
        note: Option<String>,
    ) {
        let event = Event {
            kind,
            received_at: now_ms(),
            seq,
            sent_at,
            note,
        };
        self.append_to_log(&event);
        let mut inner = self.lock();
        inner.events.push(event);
        let excess = inner.events.len().saturating_sub(MAX_EVENTS_IN_MEMORY);
        inner.events.drain(..excess);
    }

    /// One JSON line per event, so a run can be pulled off the phone and analysed (adb pull).
    fn append_to_log(&self, event: &Event) {
        let line = match serde_json::to_string(event) {
            Ok(line) => line,
            Err(_) => return,
        };
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

fn resolve(relay: &str) -> io::Result<SocketAddr> {
    relay
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "relay address did not resolve"))
}

fn write_frame(stream: &mut TcpStream, bytes: &[u8]) -> io::Result<()> {
    let length = u32::try_from(bytes.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;
    stream.write_all(&length.to_be_bytes())?;
    stream.write_all(bytes)
}

fn read_frame(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut header = [0u8; 4];
    stream.read_exact(&mut header)?;
    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut frame = vec![0u8; length];
    stream.read_exact(&mut frame)?;
    Ok(frame)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn frames_round_trip_and_oversized_frames_are_refused() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut client = TcpStream::connect(address).unwrap();
        let (mut server, _) = listener.accept().unwrap();

        write_frame(&mut client, b"{\"seq\":1,\"sentAt\":2}").unwrap();
        assert_eq!(
            read_frame(&mut server).unwrap(),
            b"{\"seq\":1,\"sentAt\":2}"
        );

        client
            .write_all(&(MAX_FRAME_BYTES as u32 + 1).to_be_bytes())
            .unwrap();
        assert!(read_frame(&mut server).is_err());
    }

    #[test]
    fn the_room_id_is_32_bytes() {
        assert_eq!(ROOM.len(), 32);
    }

    #[test]
    fn a_probe_receives_pings_from_a_relay_and_logs_them() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let relay = listener.local_addr().unwrap().to_string();
        let log = std::env::temp_dir().join(format!("fhp-probe-test-{}.jsonl", std::process::id()));
        let probe = Probe::new(relay, log.clone());
        probe.start();

        let (mut server, _) = listener.accept().unwrap();
        assert_eq!(read_frame(&mut server).unwrap(), ROOM);
        write_frame(&mut server, b"{\"seq\":7,\"sentAt\":1000}").unwrap();

        let deadline = SystemTime::now() + Duration::from_secs(5);
        while !probe
            .status()
            .events
            .iter()
            .any(|event| event.seq == Some(7))
        {
            assert!(SystemTime::now() < deadline, "ping not recorded");
            thread::sleep(Duration::from_millis(10));
        }
        assert!(probe.status().connected);
        assert!(std::fs::read_to_string(&log).unwrap().contains("\"seq\":7"));
        let _ = std::fs::remove_file(log);
    }
}
