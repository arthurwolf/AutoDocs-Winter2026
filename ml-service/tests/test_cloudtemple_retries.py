"""Bounded retries for transient Cloud Temple failures."""

import asyncio

import httpx
import pytest

import cloudtemple


SUCCESS = {
    "choices": [
        {
            "finish_reason": "stop",
            "message": {"content": "READY"},
        }
    ]
}


def run_request(client):
    return asyncio.run(
        cloudtemple.chat_completion(
            client,
            model="test-model",
            prompt="Synthetic test prompt",
            max_tokens=128,
            timeout_seconds=10,
        )
    )


def configure(monkeypatch):
    monkeypatch.setenv("CLOUDTEMPLE_API_KEY", "fake-test-key")
    monkeypatch.setenv("CLOUDTEMPLE_MAX_ATTEMPTS", "3")
    monkeypatch.delenv("CLOUDTEMPLE_BASE_URL", raising=False)


def test_retries_503_and_429(monkeypatch):
    configure(monkeypatch)
    calls = []
    delays = []

    async def fake_sleep(seconds):
        delays.append(seconds)

    monkeypatch.setattr(cloudtemple.asyncio, "sleep", fake_sleep)

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(503, json={"error": "saturation"})
        if len(calls) == 2:
            return httpx.Response(
                429,
                headers={"Retry-After": "1"},
                json={"error": "rate limit"},
            )
        return httpx.Response(200, json=SUCCESS)

    async def execute():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            return await cloudtemple.chat_completion(
                client,
                model="test-model",
                prompt="Synthetic test prompt",
                max_tokens=128,
                timeout_seconds=10,
            )

    assert asyncio.run(execute()) == "READY"
    assert len(calls) == 3
    assert delays == [2.0, 1.0]


@pytest.mark.parametrize("status", [400, 401, 403])
def test_client_errors_are_not_retried(monkeypatch, status):
    configure(monkeypatch)
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(status, json={"error": "client error"})

    async def execute():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            await cloudtemple.chat_completion(
                client,
                model="test-model",
                prompt="Synthetic test prompt",
                max_tokens=128,
                timeout_seconds=10,
            )

    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(execute())

    assert len(calls) == 1


def test_stops_after_three_503_responses(monkeypatch):
    configure(monkeypatch)
    calls = []
    delays = []

    async def fake_sleep(seconds):
        delays.append(seconds)

    monkeypatch.setattr(cloudtemple.asyncio, "sleep", fake_sleep)

    def handler(request):
        calls.append(request)
        return httpx.Response(503, json={"error": "saturation"})

    async def execute():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            await cloudtemple.chat_completion(
                client,
                model="test-model",
                prompt="Synthetic test prompt",
                max_tokens=128,
                timeout_seconds=10,
            )

    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(execute())

    assert len(calls) == 3
    assert delays == [2.0, 4.0]


def test_empty_reasoning_response_retries_and_fails(monkeypatch):
    configure(monkeypatch)
    calls = []
    delays = []

    async def fake_sleep(seconds):
        delays.append(seconds)

    monkeypatch.setattr(cloudtemple.asyncio, "sleep", fake_sleep)

    def handler(request):
        calls.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"content": ""},
                    }
                ],
                "usage": {
                    "completion_tokens": 0,
                    "reasoning_tokens": 256,
                },
            },
        )

    async def execute():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            await cloudtemple.chat_completion(
                client,
                model="test-model",
                prompt="Synthetic test prompt",
                max_tokens=256,
                timeout_seconds=10,
            )

    with pytest.raises(RuntimeError, match="no text content"):
        asyncio.run(execute())

    assert len(calls) == 3
    assert delays == [2.0, 4.0]


def test_retries_transient_connection_failure(monkeypatch):
    configure(monkeypatch)
    calls = []

    async def fake_sleep(seconds):
        pass

    monkeypatch.setattr(cloudtemple.asyncio, "sleep", fake_sleep)

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            raise httpx.ConnectError("temporary failure", request=request)
        return httpx.Response(200, json=SUCCESS)

    async def execute():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            return await cloudtemple.chat_completion(
                client,
                model="test-model",
                prompt="Synthetic test prompt",
                max_tokens=128,
                timeout_seconds=10,
            )

    assert asyncio.run(execute()) == "READY"
    assert len(calls) == 2


def test_empty_response_then_success(monkeypatch):
    configure(monkeypatch)
    calls = []
    delays = []

    async def fake_sleep(seconds):
        delays.append(seconds)

    monkeypatch.setattr(cloudtemple.asyncio, "sleep", fake_sleep)

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(
                200,
                json={
                    "choices": [{
                        "finish_reason": "stop",
                        "message": {"content": ""},
                    }]
                },
            )
        return httpx.Response(200, json=SUCCESS)

    async def execute():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            return await cloudtemple.chat_completion(
                client,
                model="test-model",
                prompt="Synthetic test prompt",
                max_tokens=128,
                timeout_seconds=10,
            )

    assert asyncio.run(execute()) == "READY"
    assert len(calls) == 2
    assert delays == [2.0]


def test_token_limit_error_is_not_retried(monkeypatch):
    configure(monkeypatch)
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [{
                    "finish_reason": "length",
                    "message": {"content": ""},
                }]
            },
        )

    async def execute():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            await cloudtemple.chat_completion(
                client,
                model="test-model",
                prompt="Synthetic test prompt",
                max_tokens=128,
                timeout_seconds=10,
            )

    with pytest.raises(RuntimeError, match="max_tokens"):
        asyncio.run(execute())

    assert len(calls) == 1
