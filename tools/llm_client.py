"""Unified multi-provider OpenAI-compatible LLM client for LVGL code generation.

Supports two endpoints per model:
  - /chat/completions  (default; most models, incl. domestic OpenAI-compatible gateways)
  - /responses          (reasoning / Codex models: gpt-5.x, o1/o3/o4, codex)

The client resolves a *nickname* or *role* into a concrete (api_key, model,
base_url, api_type) triple through a three-layer config:

  providers  -> base_url + api_key (configure once per vendor/gateway)
  models     -> nickname -> { provider, model, vision } (configure once, reuse everywhere)
  roles      -> { analyze, generate, refine } -> model nickname (pick per job type)

The settings file (workspace/.llm_settings.json) uses schema v2, but the legacy
flat format `{api_key, model, base_url}` is still accepted and upgraded on read.
"""

import base64
import json
import os
import re
import sys
import time
from pathlib import Path

import httpx

SETTINGS_PATH = Path(__file__).resolve().parent.parent / "workspace" / ".llm_settings.json"

# Model-name fragments that indicate a Responses-API (reasoning/Codex) model.
REASONING_MODEL_HINTS = ("gpt-5", "gpt-o1", "gpt-o3", "gpt-o4", "-o1", "-o3", "-o4", "codex")

# Sentinel returned by SSE parsers when the stream is logically complete.
_STREAM_DONE = "__stream_done__"

# Named roles mapped to their human-readable labels. Each pipeline step picks one.
ROLE_NAMES = {
    "analyze": "图形/页面分析",
    "generate": "代码生成",
    "refine": "精调修正",
}
DEFAULT_ROLE = "generate"

# Built-in provider presets so users never have to memorise a base URL.
# Every entry is an OpenAI-compatible `/v1` root (or equivalent chat endpoint).
PROVIDER_PRESETS = [
    {"id": "openai", "name": "OpenAI", "base_url": "https://api.openai.com/v1"},
    {"id": "deepseek", "name": "DeepSeek 深度求索", "base_url": "https://api.deepseek.com/v1"},
    {"id": "zhipu", "name": "智谱 AI (GLM)", "base_url": "https://open.bigmodel.cn/api/paas/v4"},
    {"id": "qwen", "name": "阿里云通义千问 (Qwen)", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1"},
    {"id": "moonshot", "name": "月之暗面 Kimi", "base_url": "https://api.moonshot.cn/v1"},
    {"id": "siliconflow", "name": "硅基流动 SiliconFlow", "base_url": "https://api.siliconflow.cn/v1"},
    {"id": "yi", "name": "零一万物 Yi", "base_url": "https://api.lingyiwanwu.com/v1"},
    {"id": "baidu", "name": "百度千帆 (OpenAI 兼容)", "base_url": "https://qianfan.baidubce.com/v2"},
    {"id": "ollama", "name": "Ollama (本地)", "base_url": "http://localhost:11434/v1"},
    {"id": "custom", "name": "自定义 / 其它 OpenAI 兼容", "base_url": ""},
]


def load_settings() -> dict:
    """Load settings from config file; return empty dict if missing."""
    if SETTINGS_PATH.is_file():
        try:
            return json.loads(SETTINGS_PATH.read_text("utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _debug_log(msg: str) -> None:
    """Print a debug line (always on)."""
    print(f"[llm_debug] {msg}", flush=True)


def _env_key() -> str:
    return os.environ.get("OPENAI_API_KEY", "")


def _env_model() -> str:
    return os.environ.get("OPENAI_MODEL", "gpt-4o")


def _env_base() -> str | None:
    return os.environ.get("OPENAI_BASE_URL") or None


def _providers_by_id(settings: dict) -> dict[str, dict]:
    return {p.get("id"): p for p in (settings.get("providers") or []) if p.get("id")}


def _model_by_id(settings: dict) -> dict[str, dict]:
    return {m.get("id"): m for m in (settings.get("models") or []) if m.get("id")}


def resolve_model_spec(nickname: str | None) -> dict:
    """Resolve a model nickname (or raw model name) into a concrete spec.

    Returns a dict with keys: model, api_key, base_url, api_type, chat_extra,
    vision, provider_id, provider_name, name.

    Resolution order for a nickname:
      1. an entry in settings['models'] (binds nickname -> provider + real model)
         with the provider supplying base_url/api_key.
      2. otherwise treat `nickname` as a literal model name and fall back to the
         global/legacy flat settings + environment variables.
    """
    settings = load_settings()
    models = _model_by_id(settings)
    providers = _providers_by_id(settings)

    entry = models.get(nickname) if nickname else None
    provider = providers.get(entry.get("provider")) if entry else None

    model = (entry or {}).get("model") or (entry or {}).get("id") or nickname
    if not model:
        model = _default_model()

    # api_key: provider > entry > flat settings > env
    api_key = (
        (provider or {}).get("api_key")
        or (entry or {}).get("api_key")
        or settings.get("api_key")
        or _env_key()
    )
    base_url = (
        (provider or {}).get("base_url")
        or (entry or {}).get("base_url")
        or settings.get("base_url")
        or _env_base()
        or "https://api.openai.com/v1"
    )
    api_type = (provider or {}).get("api_type") or (entry or {}).get("api_type") or settings.get("api_type")
    chat_extra = (provider or {}).get("chat_extra") or (entry or {}).get("chat_extra")

    return {
        "model": model,
        "api_key": api_key or "",
        "base_url": base_url,
        "api_type": api_type,
        "chat_extra": chat_extra,
        "vision": bool((entry or {}).get("vision", False)),
        "provider_id": (entry or {}).get("provider") or (provider or {}).get("id"),
        "provider_name": (provider or {}).get("name") or (entry or {}).get("provider"),
        "name": (entry or {}).get("name") or model,
    }


def _default_model() -> str:
    """Return the default model nickname, honouring v2 config then legacy flat config."""
    settings = load_settings()
    return (
        settings.get("default_model")
        or settings.get("model")
        or _env_model()
    )


def model_for_role(role: str | None) -> str:
    """Return the model nickname assigned to `role`, falling back to the default."""
    settings = load_settings()
    roles = settings.get("roles") or {}
    role = role or DEFAULT_ROLE
    if role in roles and roles[role]:
        return roles[role]
    return _default_model()


def has_api_key() -> bool:
    """Return True if any API key is configured (env, flat, or per provider/model)."""
    if _env_key():
        return True
    settings = load_settings()
    if settings.get("api_key"):
        return True
    for item in (settings.get("providers") or []):
        if item.get("api_key"):
            return True
    for item in (settings.get("models") or []):
        if item.get("api_key"):
            return True
    return False


def _get_config() -> tuple[str, str, str | None]:
    """Backward-compatible helper: return (api_key, model, base_url).

    Kept for any external callers that relied on the old behaviour; resolves
    through the default model spec.
    """
    spec = resolve_model_spec(_default_model())
    if not spec["api_key"]:
        raise RuntimeError(
            "OPENAI_API_KEY not set. Configure it in Web UI settings or set the environment variable."
        )
    return spec["api_key"], spec["model"], spec["base_url"] or None


def _use_responses_api(model: str, settings: dict, api_type=None) -> bool:
    """Decide whether to call /responses instead of /chat/completions.

    Priority:
      1. explicit api_type (provider / model / global)  -> 'responses'/'chat'
      2. settings['use_responses_api'] (bool) if present
      3. auto-detect by model name (gpt-5* / o1 / o3 / o4 / codex -> responses)
    """
    explicit = api_type or settings.get("api_type")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip().lower() == "responses"
    if "use_responses_api" in settings:
        return bool(settings["use_responses_api"])
    m = (model or "").lower()
    return any(h in m for h in REASONING_MODEL_HINTS)


def _messages_to_responses_input(messages: list) -> list:
    """Convert chat-style messages to Responses API `input` items.

    Roles pass through (system/user/assistant/developer). Multimodal content
    parts are remapped: text -> input_text, image_url -> input_image.
    """
    items: list = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content")
        if isinstance(content, str):
            items.append({"role": role, "content": content})
            continue
        if isinstance(content, list):
            parts: list = []
            for part in content:
                ptype = part.get("type")
                if ptype == "text":
                    parts.append({"type": "input_text", "text": part.get("text", "")})
                elif ptype == "image_url":
                    url = part.get("image_url", {}).get("url", "")
                    parts.append({"type": "input_image", "image_url": url})
                else:
                    parts.append(part)
            items.append({"role": role, "content": parts})
    return items


def _parse_chat_line(line: str) -> str | None:
    """Parse one SSE line from /chat/completions.

    Returns delta text, None (skip), or the _STREAM_DONE sentinel.
    """
    if not line.startswith("data: "):
        return None
    payload = line[6:]
    if payload.strip() == "[DONE]":
        return _STREAM_DONE
    try:
        data = json.loads(payload)
    except (json.JSONDecodeError, ValueError):
        return None
    choices = data.get("choices") or []
    if choices:
        return choices[0].get("delta", {}).get("content")
    return None


def _parse_responses_line(line: str) -> str | None:
    """Parse one SSE line from /responses.

    Returns delta text (from response.output_text.delta), None (skip), or the
    _STREAM_DONE sentinel on completion/failure events.
    """
    if not line.startswith("data: "):
        return None
    payload = line[6:]
    if payload.strip() == "[DONE]":
        return _STREAM_DONE
    try:
        data = json.loads(payload)
    except (json.JSONDecodeError, ValueError):
        return None
    etype = data.get("type", "")
    if etype == "response.output_text.delta":
        return data.get("delta")
    if etype in (
        "response.completed",
        "response.failed",
        "response.error",
        "response.incomplete",
    ):
        return _STREAM_DONE
    return None


def _do_stream(url: str, headers: dict, body: dict, parse_line) -> str:
    """POST a streaming request with retry; assemble text from SSE deltas.

    `parse_line(line) -> str | None` parses one SSE line and returns either a
    delta string, None (ignore), or the _STREAM_DONE sentinel.
    """
    last_err: Exception | None = None
    for attempt in range(5):
        try:
            with httpx.Client(timeout=httpx.Timeout(connect=30, read=300, write=30, pool=30)) as client:
                with client.stream("POST", url, json=body, headers=headers) as resp:
                    if resp.status_code != 200:
                        resp.read()
                        status = resp.status_code
                        # Don't retry client errors (except 429 rate-limit)
                        if 400 <= status < 500 and status != 429:
                            raise RuntimeError(
                                f"HTTP {status} (non-retryable): {resp.text[:300]}"
                            )
                        raise RuntimeError(f"HTTP {status}: {resp.text[:300]}")
                    _debug_log(f"HTTP status: {resp.status_code}")
                    is_tty = sys.stdout.isatty()
                    chunks: list[str] = []
                    total_chars = 0
                    raw_count = 0
                    for line in resp.iter_lines():
                        if raw_count < 8:
                            _debug_log(f"raw[{raw_count}]: {line[:300]}")
                            raw_count += 1
                        result = parse_line(line)
                        if result is _STREAM_DONE or result == _STREAM_DONE:
                            break
                        if result:
                            chunks.append(result)
                            total_chars += len(result)
                            # In a real terminal: refresh the same line with \r.
                            # When piped (e.g. the Web UI subprocess) suppress the
                            # per-chunk progress entirely so it doesn't coalesce into
                            # one giant log line that freezes the browser.
                            if is_tty:
                                print(f"\r[llm] generating... {total_chars} chars", end="", flush=True)
                    if total_chars:
                        if is_tty:
                            print(f"\r[llm] done, {total_chars} chars        ", flush=True)
                        else:
                            print(f"[llm] done, {total_chars} chars", flush=True)
                    return "".join(chunks)
        except RuntimeError as exc:
            if "non-retryable" in str(exc):
                raise
            last_err = exc
            wait = min(2 ** attempt, 30)
            print(f"[llm_client] attempt {attempt+1}/5 failed: {exc}, retrying in {wait}s...", flush=True)
            if attempt < 4:
                time.sleep(wait)
        except Exception as exc:
            last_err = exc
            wait = min(2 ** attempt, 30)
            print(f"[llm_client] attempt {attempt+1}/5 failed: {exc}, retrying in {wait}s...", flush=True)
            if attempt < 4:
                time.sleep(wait)
    raise RuntimeError(f"OpenAI API failed after 5 attempts: {last_err}")


def _apply_chat_body(body: dict, spec: dict) -> None:
    """Merge provider/model-level body overrides plus well-known endpoint tweaks.

    Some domestic models force or default to a thinking/reasoning phase that
    eats into the max_tokens budget and can truncate a JSON/C-code answer. These
    are tuned here by default; an explicit `chat_extra` on the provider or model
    always wins.
    """
    base = (spec.get("base_url") or "").lower()
    extra = dict(spec.get("chat_extra") or {})

    if "deepseek" in base and "thinking" not in extra:
        # DeepSeek reasoner models think by default; disable it so code/JSON
        # generation isn't truncated.
        extra["thinking"] = {"type": "disabled"}
    elif "bigmodel" in base and "thinking" not in extra:
        # GLM forces deep thinking (cannot be disabled). Enable it explicitly and
        # keep the reasoning depth low so the answer keeps its token budget.
        extra["thinking"] = {"type": "enabled"}
        extra.setdefault("reasoning_effort", "low")

    for key, value in extra.items():
        body[key] = value


def chat(
    messages: list,
    model: str | None = None,
    role: str | None = None,
    temperature: float = 0.2,
    max_tokens: int = 8192,
) -> str:
    """Send a completion request via raw httpx (bypasses SDK User-Agent filtering).

    `model` may be a configured nickname, a raw model name, or None. When None,
    the model assigned to `role` (default "generate") is used.

    Auto-selects /chat/completions or /responses based on the resolved model:
    reasoning / Codex models (gpt-5.x, o1/o3/o4, codex) route to /responses.
    """
    nickname = model or model_for_role(role)
    spec = resolve_model_spec(nickname)
    api_key = spec["api_key"]
    if not api_key:
        raise RuntimeError(
            "API key not set. Configure the provider/model in the Web UI "
            "LLM settings or set the OPENAI_API_KEY environment variable."
        )

    model = spec["model"]
    settings = load_settings()
    base = (spec["base_url"] or "https://api.openai.com/v1").rstrip("/")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    if _use_responses_api(model, settings, spec.get("api_type")):
        url = base + "/responses"
        body = {
            "model": model,
            "input": _messages_to_responses_input(messages),
            "max_output_tokens": max_tokens,
            "stream": True,
        }
        parse_line = _parse_responses_line
    else:
        url = base + "/chat/completions"
        body = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
        }
        _apply_chat_body(body, spec)
        parse_line = _parse_chat_line

    _debug_log(f"POST {url}")
    req = json.dumps(body, ensure_ascii=False)
    if len(req) > 2000:
        req = req[:2000] + " …(truncated)"
    _debug_log(f"request body: {req}")

    result = _do_stream(url, headers, body, parse_line)

    _debug_log(f"=== full response ({len(result)} chars) ===\n{result}\n=== end response ===")

    return result


def extract_code_block(response: str, lang: str = "c") -> str:
    """Extract the first ```<lang> ... ``` fenced code block from a response."""
    pattern = rf"```{re.escape(lang)}\s*\n(.*?)```"
    match = re.search(pattern, response, re.DOTALL)
    if match:
        return match.group(1).strip() + "\n"
    # Fallback: try any fenced block
    match = re.search(r"```\w*\s*\n(.*?)```", response, re.DOTALL)
    if match:
        return match.group(1).strip() + "\n"
    return response.strip() + "\n"


def extract_search_replace_blocks(response: str) -> list[tuple[str, str]]:
    """Parse all <<<SEARCH ... === ... >>> blocks from an LLM response.

    Returns a list of (search, replace) string tuples.
    """
    pattern = r"<<<SEARCH\n(.*?)\n===\n(.*?)\n>>>"
    return re.findall(pattern, response, re.DOTALL)


def apply_search_replace(source: str, blocks: list[tuple[str, str]]) -> str:
    """Apply search-replace blocks sequentially to source code.

    Matching strategy: exact match first, then retry with leading/trailing
    blank lines stripped from the search string. Raises ValueError on failure.
    """
    for i, (search, replace) in enumerate(blocks):
        if search in source:
            source = source.replace(search, replace, 1)
            continue
        # Retry: strip leading/trailing blank lines from search
        stripped = search.strip("\n")
        if stripped and stripped in source:
            source = source.replace(stripped, replace.strip("\n"), 1)
            continue
        # Show a short preview of the failing search block
        preview = search[:120].replace("\n", "\\n")
        raise ValueError(
            f"Block {i+1}/{len(blocks)} failed to match: '{preview}...'"
        )
    return source


def image_to_base64(path: Path) -> str:
    """Read an image file and return its base64-encoded string."""
    data = path.read_bytes()
    return base64.b64encode(data).decode("ascii")


if __name__ == "__main__":
    # Self-test for search-replace functions
    resp = "Some text\n<<<SEARCH\nint x = 1;\n===\nint x = 2;\n>>>\nmore\n<<<SEARCH\nfoo();\n===\nbar();\n>>>"
    blocks = extract_search_replace_blocks(resp)
    assert blocks == [("int x = 1;", "int x = 2;"), ("foo();", "bar();")], f"extract failed: {blocks}"

    src = "int x = 1;\nfoo();\n"
    result = apply_search_replace(src, blocks)
    assert result == "int x = 2;\nbar();\n", f"apply failed: {result!r}"

    assert extract_search_replace_blocks("no blocks here") == []

    try:
        apply_search_replace("nothing", [("missing", "x")])
        assert False, "should have raised"
    except ValueError:
        pass

    # Self-tests for the new config resolution layer (no network, no settings file).
    spec = resolve_model_spec("gpt-4o")
    assert spec["model"] == "gpt-4o", f"raw model resolution failed: {spec}"
    assert spec["base_url"].endswith("/v1"), f"default base_url wrong: {spec}"

    assert model_for_role("generate") == _default_model(), "role fallback broken"
    assert _use_responses_api("gpt-5", {}, None) is True
    assert _use_responses_api("deepseek-chat", {}, None) is False

    body = {"model": "m", "messages": [], "stream": True}
    _apply_chat_body(body, {"base_url": "https://api.deepseek.com/v1", "chat_extra": None})
    assert body.get("thinking") == {"type": "disabled"}, f"deepseek thinking tune wrong: {body}"
    body2 = {"model": "m", "messages": [], "stream": True}
    _apply_chat_body(body2, {"base_url": "https://open.bigmodel.cn/api/paas/v4", "chat_extra": {"foo": 1}})
    assert body2["thinking"] == {"type": "enabled"}, f"bigmodel thinking tune wrong: {body2}"
    assert body2["foo"] == 1

    print("llm_client self-tests passed")
