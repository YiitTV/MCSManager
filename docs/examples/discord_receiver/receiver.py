"""Minefield Panel -> Discord receiver (discord.py + aiohttp, single process).

Environment variables:
  MINEFIELD_SECRET      secret shown once by the panel (hex string, used as UTF-8 text)
  MINEFIELD_CHANNEL_ID  Discord channel id to post into
  MINEFIELD_PORT        local port to listen on (default 8787)
  DISCORD_TOKEN         your bot token (only needed by the standalone main() below)
"""

import asyncio
import hashlib
import hmac
import json
import logging
import os
import time
from collections import OrderedDict
from datetime import datetime, timezone

import discord
from aiohttp import web

log = logging.getLogger("minefield")

MAX_BODY_BYTES = 64 * 1024  # the panel never sends more than 8 KB
MAX_SKEW_SECONDS = 300  # reject requests older/newer than 5 minutes
DEDUPE_SIZE = 1000  # remember the last N event ids

# ---------------------------------------------------------------- verification


def verify_signature(secret: str, ts_header: str, sig_header: str, raw_body: bytes, now: float) -> bool:
    """Return True only if timestamp is fresh and the HMAC matches.

    message = ascii(timestamp) + "." + raw body bytes (NOT re-serialised JSON).
    key     = the secret hex string as UTF-8 text (NOT hex-decoded).
    """
    try:
        ts = int(ts_header)
    except (TypeError, ValueError):
        return False
    if abs(now - ts) > MAX_SKEW_SECONDS:
        return False
    if not sig_header or not sig_header.startswith("sha256="):
        return False
    expected = hmac.new(
        secret.encode("utf-8"), str(ts).encode("ascii") + b"." + raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest("sha256=" + expected, sig_header)


# ---------------------------------------------------------------- embed building

RED, GREEN, GREY, ORANGE, BLUE = 0xE74C3C, 0x2ECC71, 0x95A5A6, 0xE67E22, 0x3498DB


def _clip(value, limit: int) -> str:
    text = str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _esc(value) -> str:
    """Escape Discord markdown/mentions in user-controlled names."""
    text = str(value)
    for ch in ("\\", "*", "_", "`", "~", "|", ">", "@", "#", "[", "]"):
        text = text.replace(ch, "\\" + ch)
    return _clip(text, 100)


def _exit_code(code) -> str:
    return "bilinmiyor" if code is None else str(code)


def build_embed(event: dict) -> discord.Embed | None:
    """Turn one panel event into an embed. Returns None for unknown types."""
    etype = event.get("type")
    details = event.get("details") or {}
    inst = event.get("instance") or {}
    group = event.get("group") or {}
    backup = event.get("backup") or {}
    inst_name = _esc(inst.get("name", "?"))
    node_name = _esc(inst.get("daemonName", "?"))
    fields: list[tuple[str, str]] = []

    if etype == "instance.crashed":
        title, color = "❌ Sunucu çöktü", RED
        desc = f"**{inst_name}** beklenmedik şekilde kapandı."
        fields = [
            ("Çıkış kodu", _exit_code(details.get("exitCode"))),
            ("Otomatik yeniden başlatma", "Evet" if details.get("willAutoRestart") else "Hayır"),
        ]
    elif etype == "instance.started":
        title, color = "✅ Sunucu başladı", GREEN
        desc = f"**{inst_name}** çalışıyor."
    elif etype == "instance.stopped":
        title, color = "⏹ Sunucu durdu", GREY
        desc = f"**{inst_name}** durduruldu."
        fields = [("Çıkış kodu", _exit_code(details.get("exitCode")))]
    elif etype == "instance.auto_restarted":
        title, color = "\U0001f501 Sunucu otomatik yeniden başlatıldı", ORANGE
        desc = f"**{inst_name}** kapandıktan sonra tekrar başlatıldı."
        max_attempts = details.get("maxAttempts")
        fields = [
            ("Deneme", f"{details.get('attempt', '?')} / {'sınırsız' if max_attempts is None else max_attempts}")
        ]
    elif etype == "backup.succeeded":
        title, color = "\U0001f4be Yedekleme tamamlandı", GREEN
        desc = f"**{inst_name}** için yedek alındı."
        fields = [
            ("Tetikleyen", "Zamanlanmış" if backup.get("trigger") == "schedule" else "Elle"),
            ("Boyut", f"{(backup.get('sizeBytes') or 0) / 1048576:.1f} MB"),
            ("Süre", f"{backup.get('durationSec', '?')} sn"),
        ]
    elif etype == "backup.failed":
        title, color = "⚠️ Yedekleme başarısız", RED
        desc = f"**{inst_name}** için yedekleme hata verdi."
        fields = [("Neden", _clip(details.get("reason", "bilinmiyor"), 200))]
    elif etype == "group.run_started":
        title, color = "▶️ Grup çalıştırması başladı", BLUE
        desc = f"**{_esc(group.get('name', '?'))}** grubu için `{_esc(group.get('action', '?'))}` işlemi başladı."
        fields = [("Üye sayısı", str(details.get("memberCount", "?")))]
    elif etype == "group.run_finished":
        cancelled = details.get("result") == "cancelled"
        title = "\U0001f6d1 Grup çalıştırması iptal edildi" if cancelled else "✅ Grup çalıştırması tamamlandı"
        color = GREY if cancelled else GREEN
        desc = f"**{_esc(group.get('name', '?'))}** grubu için `{_esc(group.get('action', '?'))}` işlemi bitti."
        fields = [
            ("Üye sayısı", str(details.get("memberCount", "?"))),
            ("Süre", f"{details.get('durationSec', '?')} sn"),
        ]
    elif etype == "group.run_failed":
        title, color = "❌ Grup çalıştırması başarısız", RED
        desc = f"**{_esc(group.get('name', '?'))}** grubu için `{_esc(group.get('action', '?'))}` işlemi hata verdi."
        step = details.get("failedStep") or {}
        fields = [
            ("Üye sayısı", str(details.get("memberCount", "?"))),
            ("Süre", f"{details.get('durationSec', '?')} sn"),
        ]
        if step:
            fields.append(("Başarısız adım", f"{_esc(step.get('instanceName', '-'))}: {_clip(step.get('reason', '?'), 200)}"))
    elif etype == "notification.test":
        title, color = "\U0001f514 Test bildirimi", BLUE
        desc = _clip(details.get("message", "Test"), 500)
    else:
        return None  # unknown type: ignore (forward compatible)

    if etype.startswith("instance.") or etype.startswith("backup."):
        fields.append(("Düğüm", node_name))
    if details.get("suppressedBefore"):
        fields.append(("Bastırılan önceki olay", str(details["suppressedBefore"])))

    try:
        when = datetime.fromisoformat(str(event.get("timestamp")).replace("Z", "+00:00"))
    except ValueError:
        when = datetime.now(timezone.utc)
    embed = discord.Embed(title=_clip(title, 256), description=_clip(desc, 4096), colour=color, timestamp=when)
    for name, value in fields[:10]:
        embed.add_field(name=_clip(name, 256), value=_clip(value, 1024) or "-", inline=True)
    panel_name = _clip((event.get("panel") or {}).get("name", "Minefield Panel"), 40)
    embed.set_footer(text=panel_name)
    return embed


# ---------------------------------------------------------------- HTTP receiver


class MinefieldReceiver:
    def __init__(self, bot: discord.Client, secret: str, channel_id: int):
        self.bot = bot
        self.secret = secret
        self.channel_id = channel_id
        self.seen: OrderedDict[str, None] = OrderedDict()
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        self.worker: asyncio.Task | None = None

    def _is_duplicate(self, event_id: str) -> bool:
        if event_id in self.seen:
            self.seen.move_to_end(event_id)
            return True
        self.seen[event_id] = None
        while len(self.seen) > DEDUPE_SIZE:
            self.seen.popitem(last=False)
        return False

    async def handle(self, request: web.Request) -> web.Response:
        # 1. Raw bytes first; never re-serialise the JSON before verifying.
        if request.content_length is not None and request.content_length > MAX_BODY_BYTES:
            return web.Response(status=413, text="too large")
        raw = await request.content.read(MAX_BODY_BYTES + 1)
        if len(raw) > MAX_BODY_BYTES:
            return web.Response(status=413, text="too large")

        # 2-3. Timestamp window + HMAC (constant-time compare inside).
        if not verify_signature(
            self.secret,
            request.headers.get("X-Minefield-Timestamp", ""),
            request.headers.get("X-Minefield-Signature", ""),
            raw,
            time.time(),
        ):
            log.warning("rejected request: bad signature or timestamp")
            return web.Response(status=401, text="unauthorized")

        # 4. Only now parse JSON.
        try:
            event = json.loads(raw)
        except ValueError:
            return web.Response(status=400, text="bad json")
        if not isinstance(event, dict) or event.get("version") != 1 or not isinstance(event.get("id"), str):
            return web.Response(status=400, text="bad payload")

        # 5. Dedupe: retries reuse the same id.
        if self._is_duplicate(event["id"]):
            return web.Response(status=200, text="duplicate")

        # 6. Answer fast, post to Discord from a background worker.
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:
            return web.Response(status=503, text="busy")  # panel will retry later
        return web.Response(status=200, text="ok")

    async def run_worker(self) -> None:
        while True:
            event = await self.queue.get()
            try:
                embed = build_embed(event)
                if embed is None:
                    continue
                channel = self.bot.get_channel(self.channel_id) or await self.bot.fetch_channel(self.channel_id)
                await channel.send(embed=embed, allowed_mentions=discord.AllowedMentions.none())
            except Exception:
                log.exception("failed to post event %s", event.get("id"))
            finally:
                self.queue.task_done()

    async def start(self, port: int) -> web.AppRunner:
        app = web.Application(client_max_size=MAX_BODY_BYTES)
        app.router.add_post("/minefield", self.handle)
        runner = web.AppRunner(app)
        await runner.setup()
        # Bind to localhost only: Caddy/nginx on the same machine is the public face.
        await web.TCPSite(runner, "127.0.0.1", port).start()
        self.worker = asyncio.create_task(self.run_worker())
        log.info("Minefield receiver listening on 127.0.0.1:%d", port)
        return runner


# ---------------------------------------------------------------- bot wiring


class MyBot(discord.Client):
    """Replace this class with YOUR existing bot; only setup_hook/close matter."""

    def __init__(self):
        super().__init__(intents=discord.Intents.default())
        self.runner: web.AppRunner | None = None

    async def setup_hook(self) -> None:
        receiver = MinefieldReceiver(
            self,
            secret=os.environ["MINEFIELD_SECRET"],
            channel_id=int(os.environ["MINEFIELD_CHANNEL_ID"]),
        )
        self.runner = await receiver.start(int(os.environ.get("MINEFIELD_PORT", "8787")))

    async def close(self) -> None:
        if self.runner:
            await self.runner.cleanup()
        await super().close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    MyBot().run(os.environ["DISCORD_TOKEN"])
