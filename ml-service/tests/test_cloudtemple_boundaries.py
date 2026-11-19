"""Regression tests for Cloud Temple shell-prompt boundaries."""

import asyncio
import json
import xml.etree.ElementTree as ET

import model0
import parser0
import restructure


RECORDING = [
    {"version": 2, "width": 80, "height": 24},
    [0.00, "o", "demo@test:~$ "],
    [0.10, "i", "ls\r"],
    [0.20, "o", "file.txt  backup/\r\ndemo@test:~$ "],
    [0.30, "i", "pwd\r"],
    [0.40, "o", "/home/demo\r\ndemo@test:~$ "],
]


def sample_xml():
    cast_text = "\n".join(json.dumps(line) for line in RECORDING)
    return parser0.cast_to_xml(cast_text)


def test_cloud_detects_second_command(monkeypatch):
    monkeypatch.setattr(model0, "LLM_BACKEND", "cloudtemple")
    calls = []

    async def fake_classify(client, prompt):
        calls.append(prompt)
        return "old event"

    monkeypatch.setattr(model0, "classify_chunk", fake_classify)

    boundaries = asyncio.run(
        model0.find_new_event_timestamps(sample_xml(), None)
    )

    assert boundaries == ["0.3"]
    assert len(calls) == 2


def test_event_grouping_keeps_two_commands_separate():
    grouped = restructure.restructure_xml_to_events(
        sample_xml(), ["0.3"]
    )

    events = ET.fromstring(grouped).findall("event")

    assert len(events) == 2
    assert len(events[0].findall("user_input")) == 1
    assert len(events[1].findall("user_input")) == 1
    assert "ls" in (events[0].find("user_input").text or "")
    assert "pwd" in (events[1].find("user_input").text or "")


def test_ollama_behavior_unchanged(monkeypatch):
    monkeypatch.setattr(model0, "LLM_BACKEND", "ollama")
    calls = []

    async def fake_classify(client, prompt):
        calls.append(prompt)
        return "old event"

    monkeypatch.setattr(model0, "classify_chunk", fake_classify)

    boundaries = asyncio.run(
        model0.find_new_event_timestamps(sample_xml(), None)
    )

    assert boundaries == []
    assert len(calls) == 5
