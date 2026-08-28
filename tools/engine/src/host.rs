//! Talking to the host: JSON Lines on stdout, commands and replies on stdin.
//!
//! One object per line. The event rate is single digits per second, so
//! serialisation cost is irrelevant and being able to `> log.jsonl` a session,
//! or read one in a text editor while a user describes what went wrong, is worth
//! more than any binary format would buy.
//!
//! # One stream, two kinds of traffic
//!
//! Outbound: events the host acts on and never answers.
//! Inbound: commands (`Start`, `Stop`, `Configure`) AND replies to number reads.
//!
//! Mixing them on one pipe is deliberate - a second channel would need its own
//! framing, its own failure handling and its own place to deadlock, for one
//! message type. But it forces a demultiplexer: a reader thread classifies each
//! line and posts it to the right queue.
//!
//! Without that thread the engine would only ever read stdin while awaiting a
//! number, so a `Stop` sent at any other moment would sit unread forever, and
//! one sent mid-read would be discarded as "not the reply". Both are silent
//! failures of the kind this whole refactor exists to remove.
//!
//! # Why the engine asks rather than reads
//!
//! Digit recognition currently lives in the host's Tesseract. That is not a
//! defect being worked around - see 修訂紀錄 R-5, where the case against
//! Tesseract turned out to rest on two claims that did not survive checking.
//! [`HostChannel`] is one implementation of [`crate::numbers::NumberReader`];
//! swapping in a Rust one later changes nothing above this line.

use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};

use svwb_vision_native::Rect;

use crate::frame::Frame;
use crate::numbers::{NumberReader, OCR_BINARY_THRESHOLD, parse_signed_int};
use crate::protocol::{Command, Event};


/// A host's answer to one [`Event::ReadNumber`].
#[derive(Debug, serde::Deserialize)]
pub struct NumberReply {
    pub id: u64,
    /// `null` when the host could not read it - unreadable, never "absent for
    /// good", so the engine retries on the next frame.
    pub text: Option<String>,
}

/// One inbound line, once classified.
enum Inbound {
    Command(Command),
    Reply(NumberReply),
}

fn classify(line: &str) -> Option<Inbound> {
    if let Ok(reply) = serde_json::from_str::<NumberReply>(line) {
        // A command also parses as `{id?, text?}` with both absent, so require
        // the discriminator to be present rather than trusting a lenient parse.
        if line.contains("\"numberRead\"") {
            return Some(Inbound::Reply(reply));
        }
    }
    serde_json::from_str::<Command>(line).ok().map(Inbound::Command)
}

/// Both directions of the host channel.
pub struct HostChannel<W: Write> {
    out: W,
    commands: Receiver<Command>,
    replies: Receiver<NumberReply>,
    next_id: u64,
}

impl<W: Write> HostChannel<W> {
    /// Wire up against already-demultiplexed queues. Used by tests, which have
    /// no stdin to read.
    pub fn new(out: W, commands: Receiver<Command>, replies: Receiver<NumberReply>) -> Self {
        Self { out, commands, replies, next_id: 1 }
    }

    /// Take the sink back, so a test can read what was emitted.
    #[cfg(test)]
    pub fn into_inner(self) -> W {
        self.out
    }

    /// Emit one event.
    ///
    /// Flushed immediately: a host supervising this process needs to see
    /// `MatchStarted` when it happens, not when a buffer happens to fill.
    pub fn emit(&mut self, event: &Event) -> std::io::Result<()> {
        serde_json::to_writer(&mut self.out, event)?;
        self.out.write_all(b"\n")?;
        self.out.flush()
    }

    /// The next command, if the host sent one. Never blocks.
    ///
    /// Returns three outcomes, not two. An `Option` would fold "nothing waiting"
    /// together with "the host is gone", and the loop would then spin forever
    /// against a closed pipe instead of shutting down - which is exactly what the
    /// first live smoke test did.
    pub fn poll_command(&mut self) -> Inbox {
        match self.commands.try_recv() {
            Ok(command) => Inbox::Command(command),
            Err(TryRecvError::Empty) => Inbox::Empty,
            Err(TryRecvError::Disconnected) => Inbox::HostGone,
        }
    }
}

/// The result of checking for a command.
#[derive(Debug)]
pub enum Inbox {
    Command(Command),
    /// Nothing waiting; the host is still there.
    Empty,
    /// stdin closed. The host has exited or was killed, and there is no one left
    /// to answer a number read or receive an event.
    HostGone,
}

/// Reads lines from `input` forever, classifying each into the right queue.
///
/// Returns the receiving ends. The thread ends when the stream closes, which
/// drops both senders and lets the engine notice the host is gone.
pub fn demultiplex<R: BufRead + Send + 'static>(
    mut input: R,
) -> (Receiver<Command>, Receiver<NumberReply>) {
    let (command_tx, command_rx): (Sender<Command>, _) = channel();
    let (reply_tx, reply_rx): (Sender<NumberReply>, _) = channel();

    std::thread::spawn(move || {
        let mut line = String::new();
        loop {
            line.clear();
            match input.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            // Anything unparseable is dropped rather than guessed at. A stray
            // line taken for a reply would put a number from nowhere into a
            // match record.
            match classify(line.trim()) {
                Some(Inbound::Command(c)) => {
                    if command_tx.send(c).is_err() {
                        return;
                    }
                }
                Some(Inbound::Reply(r)) => {
                    if reply_tx.send(r).is_err() {
                        return;
                    }
                }
                None => {}
            }
        }
    });

    (command_rx, reply_rx)
}

impl<W: Write> NumberReader for HostChannel<W> {
    /// Ask the host, and block until it answers.
    ///
    /// Blocking is correct here: the tick has nothing else to do, the result
    /// screen is up for seconds, and an out-of-order reply would be far harder
    /// to reason about than a stalled tick. A host that never answers stalls the
    /// engine - that is a supervision problem, and the host is the process that
    /// spawned this one.
    fn read(&mut self, frame: &Frame, window: Rect) -> Option<i32> {
        let png = frame.binarize_to_png(window, OCR_BINARY_THRESHOLD)?;
        let id = self.next_id;
        self.next_id += 1;

        self.emit(&Event::ReadNumber { id, png: base64(&png) }).ok()?;

        loop {
            let reply = self.replies.recv().ok()?;
            // A late answer to an abandoned request must not be taken for this
            // one; the ids are what make that impossible.
            if reply.id == id {
                return reply.text.as_deref().and_then(parse_signed_int);
            }
        }
    }
}

/// A channel over this process's real stdio.
pub fn over_stdio() -> HostChannel<std::io::Stdout> {
    let (commands, replies) = demultiplex(BufReader::new(std::io::stdin()));
    HostChannel::new(std::io::stdout(), commands, replies)
}

/// Standard base64, no line breaks.
///
/// Hand-rolled rather than pulled in as a dependency: this is encode-only with
/// no options, the alphabet is fixed by RFC 4648, and the test below pins it
/// against the published vectors.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let packed = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(packed >> (18 - 6 * i) & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{MatchPatch, MatchRef};
    use std::sync::mpsc::channel;

    fn tiny_frame() -> Frame {
        Frame::from_image(&image::DynamicImage::new_luma8(1280, 720))
    }

    /// RFC 4648 vectors. Padding is where a hand-rolled encoder goes wrong, so
    /// every remainder length is covered.
    #[test]
    fn base64_matches_the_rfc_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // Exercises the last two alphabet entries.
        assert_eq!(base64(&[0xff, 0xef, 0xbe]), "/+++");
    }

    #[test]
    fn events_are_one_line_each() {
        let (_ctx, crx) = channel();
        let (_rtx, rrx) = channel();
        let mut out = Vec::new();
        {
            let mut channel = HostChannel::new(&mut out, crx, rrx);
            channel.emit(&Event::Ready { version: "0.1.0".into(), templates_loaded: 21 }).unwrap();
            channel
                .emit(&Event::MatchUpdated {
                    r#ref: MatchRef(1),
                    patch: MatchPatch { bp: Some(8), ..Default::default() },
                })
                .unwrap();
        }
        let text = String::from_utf8(out).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 2, "one object per line, no pretty printing");
        assert!(lines[0].starts_with("{\"event\":\"ready\""));
        assert!(lines[1].contains("\"bp\":8"));
    }

    /// A command and a reply must not be mistaken for one another. They arrive on
    /// the same pipe, and a `Configure` read as a reply would answer a pending
    /// number read with nothing.
    #[test]
    fn commands_and_replies_are_told_apart() {
        let (commands, replies) = demultiplex(std::io::Cursor::new(
            concat!(
                "{\"command\":\"stop\"}\n",
                "{\"numberRead\":true,\"id\":7,\"text\":\"+124\"}\n",
                "not json at all\n",
                "{\"command\":\"configure\",\"diagnosticsEnabled\":false}\n"
            )
            .as_bytes()
            .to_vec(),
        ));

        let mut seen_commands = Vec::new();
        while let Ok(c) = commands.recv() {
            seen_commands.push(c);
        }
        assert_eq!(seen_commands.len(), 2, "both commands survived");
        assert!(matches!(seen_commands[0], Command::Stop));

        let reply = replies.recv().expect("the reply survived");
        assert_eq!(reply.id, 7);
        assert_eq!(reply.text.as_deref(), Some("+124"));
        assert!(replies.recv().is_err(), "the garbage line produced nothing");
    }

    #[test]
    fn a_matching_reply_is_parsed() {
        let (_ctx, crx) = channel();
        let (rtx, rrx) = channel();
        rtx.send(NumberReply { id: 1, text: Some("+124".into()) }).unwrap();
        let mut ch = HostChannel::new(Vec::new(), crx, rrx);
        assert_eq!(ch.read(&tiny_frame(), Rect::new(0, 0, 90, 32)), Some(124));
    }

    /// A reply the host could not read is `None`, not a guess. The caller retries
    /// on the next frame - the screen is up for seconds.
    #[test]
    fn an_unreadable_reply_is_not_a_guess() {
        let (_ctx, crx) = channel();
        let (rtx, rrx) = channel();
        rtx.send(NumberReply { id: 1, text: None }).unwrap();
        let mut ch = HostChannel::new(Vec::new(), crx, rrx);
        assert_eq!(ch.read(&tiny_frame(), Rect::new(0, 0, 90, 32)), None);
    }

    /// A late answer to an abandoned request must not be taken for the current
    /// one, or a number from another screen lands in this match.
    #[test]
    fn a_stale_reply_is_skipped() {
        let (_ctx, crx) = channel();
        let (rtx, rrx) = channel();
        rtx.send(NumberReply { id: 99, text: Some("999".into()) }).unwrap();
        rtx.send(NumberReply { id: 1, text: Some("8".into()) }).unwrap();
        let mut ch = HostChannel::new(Vec::new(), crx, rrx);
        assert_eq!(ch.read(&tiny_frame(), Rect::new(0, 0, 90, 32)), Some(8));
    }

    /// A closed channel ends the read rather than hanging forever.
    #[test]
    fn a_closed_channel_ends_the_read() {
        let (_ctx, crx) = channel();
        let (rtx, rrx) = channel::<NumberReply>();
        drop(rtx);
        let mut ch = HostChannel::new(Vec::new(), crx, rrx);
        assert_eq!(ch.read(&tiny_frame(), Rect::new(0, 0, 90, 32)), None);
    }

    /// An out-of-bounds window is a calibration bug and must not reach the host
    /// as a request for pixels that do not exist.
    #[test]
    fn an_impossible_window_is_never_sent() {
        let (_ctx, crx) = channel();
        let (_rtx, rrx) = channel();
        let mut out = Vec::new();
        let answered = {
            let mut ch = HostChannel::new(&mut out, crx, rrx);
            ch.read(&tiny_frame(), Rect::new(1200, 700, 200, 200))
        };
        assert_eq!(answered, None);
        assert!(out.is_empty(), "nothing should have been asked");
    }
}
