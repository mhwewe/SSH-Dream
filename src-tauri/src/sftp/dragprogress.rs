//! sftp/dragprogress.rs — progress bookkeeping for drag-out to Explorer (pure std, no Tauri, unit-tested).
//!
//! WHY THIS EXISTS (read this first, AI reader)
//!   A drag to Explorer (see dragout.rs) does not go through transfer.rs: Explorer pulls the bytes itself through
//!   `IStream::Read`, so nothing told the "Transfers" list about it. dragout.rs now creates ONE "group" per dragged
//!   top-level item (a plain file = one group; a folder = one group holding every file inside it, like a folder Download)
//!   and every stream reader reports the bytes it hands to Explorer into its group. This file is the state machine of
//!   one group: it counts bytes, decides which events the UI should get and makes sure a group ends exactly ONCE.
//!
//! WHAT IT DOES NOT DO
//!   It never sends anything itself: every method returns `Option<Update>` and the caller (dragout.rs `DragGroup`)
//!   sends it through the Tauri channel WHILE HOLDING the group's lock, so events of one group can never be reordered
//!   (a late "running" can never overwrite "done").
//!
//! RULES THAT ARE EASY TO BREAK
//!   * A terminal state (done / error / cancelled) is final. Every later call returns `None`.
//!   * Per-file progress is ASSIGNED (not added): if Explorer re-opens a stream and starts the file again, the group's
//!     byte count goes back instead of counting the same bytes twice.
//!   * `Update.state` strings are the UI contract (`TransferProgress.state`): "queued" | "running" | "done" | "error" | "cancelled".
//!   * Opening a stream does not start the row (Explorer may open one only to ask for its size); the first `add` does.
//!   * `UNUSED` is a marker in `Update.error` for a group that was never read at all (the drag ended on something that
//!     does not accept virtual files, or the user pressed Esc). The UI removes such rows instead of showing "Cancelled".

// Parts of this file are only used by the Windows-only drag code in dragout.rs.
#![cfg_attr(not(windows), allow(dead_code))]

use std::time::{Duration, Instant};

/// "Progress" events of a running group are sent at most this often (same rate as transfer.rs).
pub const EMIT_EVERY: Duration = Duration::from_millis(100);

/// Value of `Update.error` for a group that Explorer never touched. Keep in sync with `DRAG_UNUSED` in store/sftp.ts.
pub const UNUSED: &str = "drag-unused";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Queued,
    Running,
    Done,
    Cancelled,
    Failed,
}

/// One event for the UI (the caller turns it into a `TransferProgress`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Update {
    pub state: &'static str,
    pub done: u64,
    pub total: u64,
    pub error: Option<String>,
}

/// Progress of one dragged top-level item (one file, or one folder with all its files).
pub struct GroupProgress {
    /// Announced size of every file of the group (same order as the `delivered` vector).
    sizes: Vec<u64>,
    /// Bytes handed to Explorer so far, per file.
    delivered: Vec<u64>,
    total: u64,
    done: u64,
    /// Number of files that are fully delivered (empty files count from the start).
    complete: usize,
    phase: Phase,
    last_emit: Option<Instant>,
    /// Stream readers that currently exist for files of this group.
    readers: usize,
    /// True once any reader was created (used to tell "never touched" from "stopped half way").
    ever_opened: bool,
    last_touch: Instant,
}

impl GroupProgress {
    pub fn new(sizes: Vec<u64>, now: Instant) -> Self {
        let total = sizes.iter().sum();
        let complete = sizes.iter().filter(|s| **s == 0).count();
        let n = sizes.len();
        Self {
            sizes,
            delivered: vec![0; n],
            total,
            done: 0,
            complete,
            phase: Phase::Queued,
            last_emit: None,
            readers: 0,
            ever_opened: false,
            last_touch: now,
        }
    }

    /// The "queued" event shown when the drag starts (all rows appear at once).
    pub fn queued_update(&self) -> Update {
        Update { state: "queued", done: 0, total: self.total, error: None }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self.phase, Phase::Done | Phase::Cancelled | Phase::Failed)
    }
    pub fn readers(&self) -> usize {
        self.readers
    }
    pub fn last_touch(&self) -> Instant {
        self.last_touch
    }
    #[cfg(test)]
    pub fn ever_opened(&self) -> bool {
        self.ever_opened
    }
    #[cfg(test)]
    pub fn done_bytes(&self) -> u64 {
        self.done
    }

    fn all_complete(&self) -> bool {
        self.complete == self.sizes.len()
    }

    fn finish_done(&mut self) -> Update {
        self.phase = Phase::Done;
        self.done = self.total;
        Update { state: "done", done: self.total, total: self.total, error: None }
    }

    /// Explorer created a stream for file `_idx` of this group.
    /// A group made only of empty files is finished as soon as Explorer opens one of them
    /// (Explorer may never call `Read` on an empty stream).
    pub fn reader_opened(&mut self, _idx: usize, now: Instant) -> Option<Update> {
        self.readers += 1;
        self.ever_opened = true;
        self.last_touch = now;
        if self.is_terminal() {
            return None;
        }
        // Only the first real `add` switches "queued" to "running": Explorer may open a stream just to ask its size.
        if self.all_complete() {
            return Some(self.finish_done());
        }
        None
    }

    /// A stream reader was dropped (Explorer finished with it or stopped).
    pub fn reader_closed(&mut self, now: Instant) {
        self.readers = self.readers.saturating_sub(1);
        self.last_touch = now;
    }

    /// File `idx` has now handed `delivered` bytes in total to Explorer.
    pub fn add(&mut self, idx: usize, delivered: u64, now: Instant) -> Option<Update> {
        self.last_touch = now;
        if self.is_terminal() || idx >= self.sizes.len() {
            return None;
        }
        let size = self.sizes[idx];
        let new = delivered.min(size);
        let old = self.delivered[idx];
        self.done = self.done - old + new;
        self.delivered[idx] = new;
        if old < size && new == size {
            self.complete += 1;
        } else if old == size && new < size {
            self.complete -= 1;
        }
        if self.all_complete() {
            return Some(self.finish_done());
        }
        let first = self.phase == Phase::Queued;
        self.phase = Phase::Running;
        let due = match self.last_emit {
            None => true,
            Some(t) => now.duration_since(t) >= EMIT_EVERY,
        };
        if first || due {
            self.last_emit = Some(now);
            Some(Update { state: "running", done: self.done, total: self.total, error: None })
        } else {
            None
        }
    }

    /// The copy failed (network error, file shorter than listed, stall, connection closed).
    pub fn fail(&mut self, message: String) -> Option<Update> {
        if self.is_terminal() {
            return None;
        }
        self.phase = Phase::Failed;
        Some(Update { state: "error", done: self.done, total: self.total, error: Some(message) })
    }

    /// The user pressed Cancel (or Explorer's copy stopped half way).
    pub fn cancel(&mut self) -> Option<Update> {
        if self.is_terminal() {
            return None;
        }
        self.phase = Phase::Cancelled;
        Some(Update { state: "cancelled", done: self.done, total: self.total, error: None })
    }

    /// Used by the end-of-drag watchdog: the drag is over and Explorer has stopped asking for data.
    /// A group Explorer never opened is reported as `UNUSED` (the UI removes the row); a group that was
    /// started but not finished is a plain "cancelled" (Explorer's own Cancel button, or an error shown by Explorer).
    pub fn give_up(&mut self) -> Option<Update> {
        if self.is_terminal() {
            return None;
        }
        self.phase = Phase::Cancelled;
        let error = if self.ever_opened { None } else { Some(UNUSED.to_string()) };
        Some(Update { state: "cancelled", done: self.done, total: self.total, error })
    }
}

/// Group files by their FIRST path component: "a.txt" -> group "a.txt"; "Folder/x/y.txt" -> group "Folder".
/// Returns `(group name, indexes of the files)` in order of first appearance.
pub fn group_by_top(rel_paths: &[&str]) -> Vec<(String, Vec<usize>)> {
    let mut out: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, p) in rel_paths.iter().enumerate() {
        let top = p.split('/').find(|c| !c.is_empty()).unwrap_or(p);
        match out.iter_mut().find(|(n, _)| n == top) {
            Some((_, v)) => v.push(i),
            None => out.push((top.to_string(), vec![i])),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn groups_keep_order_and_split_by_top_component() {
        let g = group_by_top(&["a.txt", "Dir/x/1.bin", "b.txt", "Dir/2.bin"]);
        assert_eq!(
            g,
            vec![
                ("a.txt".to_string(), vec![0]),
                ("Dir".to_string(), vec![1, 3]),
                ("b.txt".to_string(), vec![2]),
            ]
        );
    }

    #[test]
    fn single_file_runs_then_finishes_once() {
        let now = t0();
        let mut g = GroupProgress::new(vec![100], now);
        assert_eq!(g.queued_update().state, "queued");
        assert_eq!(g.queued_update().total, 100);
        // first read: row switches to running at once
        let u = g.add(0, 40, now).unwrap();
        assert_eq!((u.state, u.done, u.total), ("running", 40, 100));
        // a second read inside the throttle window is silent
        assert!(g.add(0, 60, now + Duration::from_millis(10)).is_none());
        // after the throttle window it is reported
        let u = g.add(0, 80, now + Duration::from_millis(150)).unwrap();
        assert_eq!((u.state, u.done), ("running", 80));
        // the last byte ends the group immediately, whatever the throttle says
        let u = g.add(0, 100, now + Duration::from_millis(151)).unwrap();
        assert_eq!((u.state, u.done, u.total), ("done", 100, 100));
        assert!(g.is_terminal());
        // terminal is final
        assert!(g.add(0, 100, now).is_none());
        assert!(g.fail("x".into()).is_none());
        assert!(g.cancel().is_none());
        assert!(g.give_up().is_none());
    }

    #[test]
    fn folder_group_needs_all_files() {
        let now = t0();
        let mut g = GroupProgress::new(vec![10, 0, 30], now); // the empty file counts as complete
        assert_eq!(g.queued_update().total, 40);
        assert_eq!(g.add(0, 10, now).unwrap().state, "running"); // first event, file 0 complete, still not done
        assert!(!g.is_terminal());
        let u = g.add(2, 30, now + Duration::from_millis(200)).unwrap();
        assert_eq!((u.state, u.done, u.total), ("done", 40, 40));
    }

    #[test]
    fn restarting_a_file_does_not_double_count() {
        let now = t0();
        let mut g = GroupProgress::new(vec![100], now);
        g.add(0, 70, now);
        // Explorer opened a fresh stream and starts again from byte 0
        g.add(0, 20, now + Duration::from_millis(500));
        assert_eq!(g.done_bytes(), 20);
        let u = g.add(0, 100, now + Duration::from_millis(900)).unwrap();
        assert_eq!(u.state, "done");
    }

    #[test]
    fn overshoot_is_clamped() {
        let now = t0();
        let mut g = GroupProgress::new(vec![10], now);
        let u = g.add(0, 9999, now).unwrap();
        assert_eq!((u.state, u.done), ("done", 10));
    }

    #[test]
    fn empty_only_group_finishes_when_opened() {
        let now = t0();
        let mut g = GroupProgress::new(vec![0, 0], now);
        let u = g.reader_opened(0, now).unwrap();
        assert_eq!((u.state, u.done, u.total), ("done", 0, 0));
    }

    #[test]
    fn opening_a_reader_does_not_start_the_row() {
        let now = t0();
        let mut g = GroupProgress::new(vec![5], now);
        assert!(g.reader_opened(0, now).is_none()); // still "queued" until bytes are read
        assert!(g.ever_opened());
        assert_eq!(g.readers(), 1);
        g.reader_closed(now);
        assert_eq!(g.readers(), 0);
        g.reader_closed(now); // never underflows
        assert_eq!(g.readers(), 0);
    }

    #[test]
    fn failure_and_cancel_keep_the_byte_count() {
        let now = t0();
        let mut g = GroupProgress::new(vec![100], now);
        g.add(0, 30, now);
        let u = g.fail("The server stopped sending data.".into()).unwrap();
        assert_eq!((u.state, u.done), ("error", 30));
        assert_eq!(u.error.as_deref(), Some("The server stopped sending data."));

        let mut g = GroupProgress::new(vec![100], now);
        g.add(0, 30, now);
        let u = g.cancel().unwrap();
        assert_eq!((u.state, u.done, u.error), ("cancelled", 30, None));
    }

    #[test]
    fn give_up_distinguishes_untouched_from_stopped() {
        let now = t0();
        let mut never = GroupProgress::new(vec![100], now);
        let u = never.give_up().unwrap();
        assert_eq!((u.state, u.error.as_deref()), ("cancelled", Some(UNUSED)));

        let mut stopped = GroupProgress::new(vec![100], now);
        stopped.reader_opened(0, now);
        stopped.add(0, 10, now);
        stopped.reader_closed(now);
        let u = stopped.give_up().unwrap();
        assert_eq!((u.state, u.error), ("cancelled", None));
    }
}
