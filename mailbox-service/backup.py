"""Create a consistent, owner-readable SQLite snapshot without stopping the service."""
import datetime
import os
import pathlib
import sqlite3

os.umask(0o077)
source = pathlib.Path(os.environ.get("DOT_DATA", "/var/lib/dot-mailbox")) / "mailbox.sqlite"
target = pathlib.Path("/var/backups/dot-mailbox")
target.mkdir(mode=0o700, parents=True, exist_ok=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
destination = target / ("mailbox-" + stamp + ".sqlite")
with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as incoming:
    with sqlite3.connect(destination) as outgoing:
        incoming.backup(outgoing, pages=64, sleep=0.05)
        if outgoing.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Backup integrity check failed")
for expired in sorted(target.glob("mailbox-????????T??????Z.sqlite"), reverse=True)[3:]:
    expired.unlink()
print("Mailbox backup complete")
