
import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch


def test_completed_job_preserves_event_xml():
    original_xml = '<event>\n<output>echo &amp; hello</output>\n</event>'

    class Store:
        saved = None

        async def running(self, *args): pass
        async def input_content(self, *args): return 'test recording'
        async def stage(self, *args): pass
        async def progress(self, *args): pass
        async def complete_stage(self, *args): pass

        async def completed(self, job_id, result):
            self.saved = result

    class Client:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return False

    async def boundaries(*args):
        return []

    async def annotate(events, client, callback):
        return {0: {'depth': -1, 'summary': 'Run command'}}

    def fake_module(name, **attributes):
        module = ModuleType(name)
        for key, value in attributes.items():
            setattr(module, key, value)
        return module

    modules = {
        'httpx': fake_module('httpx', AsyncClient=Client),
        'model0': fake_module(
            'model0',
            extract_chunks=lambda xml: ['chunk'],
            find_new_event_timestamps=boundaries,
        ),
        'model1': fake_module(
            'model1',
            load_events=lambda path: [SimpleNamespace(xml=original_xml)],
            annotate_events=annotate,
        ),
        'parser0': fake_module(
            'parser0',
            cast_to_xml=lambda content, strip_annotations: '<recording/>',
        ),
        'restructure': fake_module(
            'restructure',
            restructure_xml_to_events=lambda xml, boundaries: '<recording/>',
        ),
        'job_store': fake_module('job_store', JobStore=Store),
    }

    source = Path(__file__).resolve().parents[1] / 'job_runner.py'
    spec = importlib.util.spec_from_file_location('tested_job_runner', source)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)

    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)

    store = Store()
    asyncio.run(module.JobRunner(store)._run('test-job'))

    assert store.saved is not None
    result = [json.loads(item) for item in store.saved['content']]

    assert result == [{
        'idx': 0,
        'depth': -1,
        'summary': 'Run command',
        'xml': original_xml,
    }]
