"""Regression tests for durable ML job deletion."""

import sys
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_store import JobStore


class JobStoreDeletionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = JobStore(self.temp.name)

    async def create_job(self):
        job_id = str(uuid4())
        await self.store.create(job_id, "Test", "test recording")
        return job_id

    async def test_failed_job_is_removed(self):
        job_id = await self.create_job()
        await self.store.failed(job_id, "ReadTimeout")

        await self.store.delete_failed(job_id)

        self.assertFalse((self.root / f"{job_id}.json").exists())
        self.assertFalse((self.root / f"{job_id}.cast").exists())

    async def test_queued_job_is_protected(self):
        job_id = await self.create_job()

        with self.assertRaises(ValueError):
            await self.store.delete_failed(job_id)

        self.assertTrue((self.root / f"{job_id}.json").exists())
        self.assertTrue((self.root / f"{job_id}.cast").exists())

    async def test_running_job_is_protected(self):
        job_id = await self.create_job()
        await self.store.running(job_id)

        with self.assertRaises(ValueError):
            await self.store.delete_failed(job_id)

        self.assertEqual((await self.store.status(job_id))["status"], "running")

    async def test_completed_job_is_protected(self):
        job_id = await self.create_job()
        await self.store.completed(job_id, {"content": []})

        with self.assertRaises(ValueError):
            await self.store.delete_failed(job_id)

        self.assertEqual((await self.store.status(job_id))["status"], "completed")

    async def test_unknown_job_is_rejected(self):
        with self.assertRaises(KeyError):
            await self.store.delete_failed(str(uuid4()))


if __name__ == "__main__":
    unittest.main()
