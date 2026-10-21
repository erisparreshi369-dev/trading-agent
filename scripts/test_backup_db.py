"""python -m unittest discover -s scripts"""
from __future__ import annotations

import gzip
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "shared"))
import backup_db as b  # noqa: E402
from migrate import connect, migrate  # noqa: E402

NOW = 1_800_000_000.0


class Backups(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "data" / "trading.db"
        self.c = connect(str(self.db))
        migrate(self.c)
        for i in range(50):
            self.trade(i)
        self.c.execute("INSERT INTO paper_account (id, balance_sol, start_balance, created_at) VALUES (1, 0.97, 1, 0)")

    def tearDown(self):
        self.c.close()
        self.tmp.cleanup()

    def trade(self, i: int) -> None:
        self.c.execute("""INSERT INTO trades (signature, ev_index, slot, received_at, mint, wallet, is_buy, sol_lamports, token_amount, source)
                          VALUES (?, 0, ?, ?, 'm', 'w', 1, 1000, 1000, 'helius')""", (f"sig{i}", i, i))

    def test_backup_is_compressed_private_and_restores_with_the_same_rows(self):
        m = b.backup(self.db, now=NOW)
        gz = b.backups_dir(self.db) / m["file"]
        self.assertEqual(m["file"], "trading-2027-01-15T0800Z.db.gz")
        self.assertEqual(m["tables"]["trades"], 50)
        self.assertEqual(m["tables"]["paper_account"], 1)
        self.assertEqual(gz.stat().st_mode & 0o777, 0o600)
        self.assertEqual(b.manifest_path(gz).stat().st_mode & 0o777, 0o600)
        self.assertEqual(b.backups_dir(self.db).stat().st_mode & 0o777, 0o700)
        r = b.test_restore(gz)
        self.assertEqual(r["rows"], sum(m["tables"].values()))
        self.assertEqual(r["migrations_applied"], [])
        # and it really is the data
        out = Path(self.tmp.name) / "check.db"
        b.unpack(gz, out)
        self.assertEqual(sqlite3.connect(out).execute("SELECT balance_sol FROM paper_account").fetchone()[0], 0.97)
        self.assertEqual(list(b.backups_dir(self.db).glob(".*")), [])  # scratch folders cleaned up

    def test_snapshot_includes_what_is_only_in_the_wal(self):
        self.c.execute("PRAGMA wal_autocheckpoint = 0")
        for i in range(50, 60):
            self.trade(i)
        self.assertGreater(Path(f"{self.db}-wal").stat().st_size, 0)
        self.assertEqual(b.backup(self.db, now=NOW)["tables"]["trades"], 60)

    def test_a_damaged_file_fails_the_test(self):
        gz = b.backups_dir(self.db) / b.backup(self.db, now=NOW)["file"]
        data = bytearray(gz.read_bytes())
        data[len(data) // 2] ^= 0xFF
        gz.write_bytes(bytes(data))
        with self.assertRaisesRegex(b.BackupError, "damaged"):
            b.test_restore(gz)

    def test_rows_missing_from_the_backup_fail_the_test(self):
        gz = b.backups_dir(self.db) / b.backup(self.db, now=NOW)["file"]
        mp = b.manifest_path(gz)
        m = json.loads(mp.read_text())
        m["tables"]["trades"] += 1
        mp.write_text(json.dumps(m))
        with self.assertRaisesRegex(b.BackupError, "row counts differ"):
            b.test_restore(gz)

    def test_a_backup_made_by_newer_code_is_flagged(self):
        gz = b.backups_dir(self.db) / b.backup(self.db, now=NOW)["file"]
        mp = b.manifest_path(gz)
        m = json.loads(mp.read_text())
        m["migrations"].append("999_future.sql")
        mp.write_text(json.dumps(m))
        with self.assertRaisesRegex(b.BackupError, "newer code"):
            b.test_restore(gz)

    def test_keeps_only_the_newest(self):
        for d in range(10):
            b.backup(self.db, keep=3, now=NOW + d * 86_400)
        names = [p.name for p in b.list_backups(self.db)]
        self.assertEqual(names, ["trading-2027-01-24T0800Z.db.gz", "trading-2027-01-23T0800Z.db.gz", "trading-2027-01-22T0800Z.db.gz"])
        self.assertEqual(len(list(b.backups_dir(self.db).glob("*.json"))), 3)

    def test_refuses_when_the_disk_is_too_full(self):
        with mock.patch.object(b.shutil, "disk_usage", return_value=mock.Mock(free=1000)):
            with self.assertRaisesRegex(b.BackupError, "not enough disk space"):
                b.backup(self.db, now=NOW)
        self.assertEqual(b.list_backups(self.db), [])

    def test_restore_refuses_while_services_run(self):
        gz = b.backups_dir(self.db) / b.backup(self.db, now=NOW)["file"]
        with self.assertRaisesRegex(b.BackupError, "stop these first.*: trader"):
            b.restore(gz, self.db, ["trader"])
        self.assertEqual(self.c.execute("SELECT count(*) FROM trades").fetchone()[0], 50)

    def test_restore_puts_the_backup_back_and_keeps_the_old_database(self):
        gz = b.backups_dir(self.db) / b.backup(self.db, now=NOW)["file"]
        for i in range(50, 80):  # written after the backup: a restore goes back to before these
            self.trade(i)
        self.c.close()
        aside = b.restore(gz, self.db, [])
        self.assertEqual(sqlite3.connect(self.db).execute("SELECT count(*) FROM trades").fetchone()[0], 50)
        self.assertEqual(self.db.stat().st_mode & 0o777, 0o600)
        old = sqlite3.connect(aside / "trading.db")  # nothing deleted: the newer data is still there
        self.assertEqual(old.execute("SELECT count(*) FROM trades").fetchone()[0], 80)
        old.close()
        self.c = connect(str(self.db))

    def test_main_records_the_result(self):
        with mock.patch.object(b, "DB", self.db):
            self.assertEqual(b.main(["backup"]), 0)
            last = json.loads(self.c.execute("SELECT value FROM kv WHERE key = 'backup.last'").fetchone()[0])
            self.assertTrue(last["ok"] and last["tested"])
            with mock.patch.object(b.shutil, "disk_usage", return_value=mock.Mock(free=1000)):
                self.assertEqual(b.main(["backup"]), 1)
            last = json.loads(self.c.execute("SELECT value FROM kv WHERE key = 'backup.last'").fetchone()[0])
            self.assertFalse(last["ok"])
            self.assertIn("disk space", last["error"])
            self.assertEqual(b.main(["test"]), 0)
            self.assertEqual(b.main(["restore", "x.db.gz"]), 1)  # no --yes


if __name__ == "__main__":
    unittest.main()
