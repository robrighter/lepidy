use lepidy_desktop_lib::local_store::{ChannelRecord, LocalContentStore, MessageWrite, StoreError};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

struct TestStore {
    path: PathBuf,
    store: LocalContentStore,
}

impl TestStore {
    fn open(label: &str, workspace_id: &str, epoch: i64) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "lepidy-{label}-{}-{nonce}.sqlite3",
            std::process::id()
        ));
        let store = LocalContentStore::open(&path, workspace_id, epoch).unwrap();
        Self { path, store }
    }
}

impl Drop for TestStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn channel() -> ChannelRecord {
    ChannelRecord {
        id: "channel-1".into(),
        kind: "public".into(),
        slug: Some("general".into()),
        name: Some("General".into()),
        created_at: 10,
        updated_at: 10,
    }
}

fn message(epoch: i64) -> MessageWrite {
    MessageWrite {
        request_id: "request-message-001".into(),
        message_id: "message-1".into(),
        host_epoch: epoch,
        channel_id: "channel-1".into(),
        author_id: "member-1".into(),
        body_markdown: "local content canary".into(),
        created_at: 20,
    }
}

#[test]
fn local_content_001_commits_before_ack_and_replays_idempotently() {
    let mut fixture = TestStore::open("commit", "workspace-1", 1);
    fixture.store.put_channel(&channel()).unwrap();
    let first = fixture.store.commit_message(&message(1)).unwrap();
    assert!(!first.replayed);

    let reopened = LocalContentStore::open(&fixture.path, "workspace-1", 1).unwrap();
    assert_eq!(
        reopened
            .get_message("message-1")
            .unwrap()
            .unwrap()
            .body_markdown,
        "local content canary"
    );

    let replay = fixture.store.commit_message(&message(1)).unwrap();
    assert!(replay.replayed);
    let mut conflict = message(1);
    conflict.body_markdown = "changed".into();
    assert!(matches!(
        fixture.store.commit_message(&conflict),
        Err(StoreError::IdempotencyConflict)
    ));
}

#[test]
fn local_content_002_fences_writes_from_an_old_host_epoch() {
    let mut fixture = TestStore::open("epoch", "workspace-1", 1);
    fixture.store.put_channel(&channel()).unwrap();
    fixture.store.set_host_epoch(2).unwrap();
    assert!(matches!(
        fixture.store.commit_message(&message(1)),
        Err(StoreError::StaleHostEpoch)
    ));
    assert!(fixture.store.get_message("message-1").unwrap().is_none());
    assert!(matches!(
        fixture.store.set_host_epoch(4),
        Err(StoreError::InvalidHostEpoch)
    ));
}

#[test]
fn solo_transfer_001_exports_verifies_and_imports_complete_content() {
    let mut old_host = TestStore::open("old-host", "workspace-1", 1);
    old_host.store.put_channel(&channel()).unwrap();
    old_host.store.commit_message(&message(1)).unwrap();
    let snapshot = old_host.store.export_snapshot().unwrap();

    let mut new_host = TestStore::open("new-host", "workspace-1", 0);
    new_host.store.import_snapshot(&snapshot).unwrap();
    assert_eq!(new_host.store.export_snapshot().unwrap(), snapshot);
    new_host.store.set_host_epoch(2).unwrap();

    let mut tampered = snapshot;
    tampered.payload.messages[0].body_markdown = "tampered".into();
    assert!(matches!(
        new_host.store.import_snapshot(&tampered),
        Err(StoreError::SnapshotChecksum)
    ));
}
