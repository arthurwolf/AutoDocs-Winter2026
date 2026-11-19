"""Tests for Cloud Temple API handling without network requests."""

import asyncio

import pytest

from cloudtemple import chat_completion


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self.data


class FakeClient:
    def __init__(self, data):
        self.data = data
        self.request = None

    async def post(self, url, **kwargs):
        self.request = (url, kwargs)
        return FakeResponse(self.data)


def test_chat_completion(monkeypatch):
    monkeypatch.setenv("CLOUDTEMPLE_API_KEY", "test-key-not-real")
    monkeypatch.delenv("CLOUDTEMPLE_BASE_URL", raising=False)

    client = FakeClient({
        "choices": [{
            "finish_reason": "stop",
            "message": {"content": "  new event  "},
        }]
    })

    result = asyncio.run(chat_completion(
        client,
        model="test-model",
        prompt="Classify this event",
        max_tokens=256,
        timeout_seconds=30,
    ))

    assert result == "new event"
    url, options = client.request
    assert url == "https://api.ai.cloud-temple.com/v1/chat/completions"
    assert options["headers"]["Authorization"] == "Bearer test-key-not-real"
    assert options["json"]["model"] == "test-model"
    assert options["json"]["messages"] == [
        {"role": "user", "content": "Classify this event"}
    ]
    assert options["json"]["stream"] is False


def test_missing_key(monkeypatch):
    monkeypatch.delenv("CLOUDTEMPLE_API_KEY", raising=False)

    with pytest.raises(ValueError, match="CLOUDTEMPLE_API_KEY"):
        asyncio.run(chat_completion(
            FakeClient({}),
            model="test-model",
            prompt="test",
            max_tokens=100,
            timeout_seconds=30,
        ))


def test_truncated_response(monkeypatch):
    monkeypatch.setenv("CLOUDTEMPLE_API_KEY", "test-key-not-real")

    client = FakeClient({
        "choices": [{
            "finish_reason": "length",
            "message": {"content": "incomplete"},
        }]
    })

    with pytest.raises(RuntimeError, match="max_tokens"):
        asyncio.run(chat_completion(
            client,
            model="test-model",
            prompt="test",
            max_tokens=100,
            timeout_seconds=30,
        ))
