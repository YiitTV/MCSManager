# Discord Bot Alıcısı (Minefield Panel Bildirimleri)

Bu belge, Minefield Panel'in sunucu olaylarını (çökme, başlatma, durdurma, yedekleme, grup çalıştırmaları) Discord'a nasıl göndereceğini anlatır. Hedef kitle: panelden **farklı bir sunucuda** çalışan, discord.py ile yazılmış mevcut bir Discord botu olan sunucu sahibi.

## 1. Genel bakış: iki gönderim seçeneği

| Seçenek | Nasıl çalışır | Ne zaman seçmeli |
| --- | --- | --- |
| `discord_webhook` | Panel, olayı doğrudan bir Discord webhook adresine embed olarak gönderir. Kendi bot kodun gerekmez. | Hızlı kurulum istiyorsan ve gelen olayları kendi botunda işlemeyeceksen. |
| `bot_http` | Panel, imzalı bir JSON isteğini (HTTPS POST) senin botunun alıcı adresine gönderir; botun Discord'a yazar. | Mevcut botunun mesaj biçimini, kanal seçimini veya ek mantığını (rol etiketleme, komutlar vb.) kontrol etmek istiyorsan. |

Bu belgenin geri kalanı `bot_http` seçeneğini anlatır. Webhook için yalnızca Discord'da kanal ayarları > Entegrasyonlar > Webhook'lar yolundan bir webhook oluşturup adresini panele yapıştırman yeterlidir (adres `https://discord.com/api/webhooks/...` biçiminde olmalıdır).

Teslimat anlamı: **en iyi çaba** (best effort). Başarısız istekler yeniden denenir ve tekrarlarda aynı `id` kullanılır (yeni zaman damgası ve imza ile). Panel yeniden başlarsa kuyruktaki olaylar kaybolur. Bir daemon bağlantısı kopukken oluşan olaylar sonradan tekrar gönderilmez.

## 2. Kurulum adımları

### 2.1 Bağımlılıklar

Botunun çalıştığı sunucuda:

```bash
pip install aiohttp discord.py
```

### 2.2 Alıcıyı mevcut bota ekleme

Alıcı, ikinci bir süreç değildir; botunun kendi event loop'u içinde bir `aiohttp` web sunucusu olarak çalışır. Bunun için botunun `setup_hook` metodunda `aiohttp.web.AppRunner` başlatılır. Aşağıdaki kodda `MyBot` sınıfı örnektir: kendi botunda yalnızca `MinefieldReceiver` sınıfını ve `verify_signature` / `build_embed` fonksiyonlarını kopyala, `setup_hook` ve `close` içindeki satırları kendi sınıfına ekle.

Aynı dosya `docs/examples/discord_receiver/receiver.py` olarak da depoda bulunur.

### 2.3 Ortam değişkenleri

| Değişken | Açıklama |
| --- | --- |
| `MINEFIELD_SECRET` | Panelin bir kez gösterdiği gizli anahtar (hex metin; olduğu gibi kullanılır). |
| `MINEFIELD_CHANNEL_ID` | Bildirimlerin gideceği Discord kanalının sayısal kimliği (geliştirici modunda kanala sağ tıkla > ID'yi kopyala). |
| `MINEFIELD_PORT` | Alıcının dinleyeceği yerel port (varsayılan `8787`). |
| `DISCORD_TOKEN` | Yalnızca örnekteki bağımsız `__main__` bloğu için; mevcut botunda zaten vardır. |

Gizli anahtarı koda yazma; systemd `EnvironmentFile=` veya `.env` dosyası (izinleri `600`) kullan.

### 2.4 Güvenlik duvarı ve HTTPS

Panel `bot_http` için yalnızca **herkese açık adreslere HTTPS** ile bağlanır (özel/LAN adresleri ve düz HTTP varsayılan olarak reddedilir; bu, panelin iç ağa istek göndermesini engelleyen SSRF korumasıdır). Bu yüzden alıcının önüne geçerli sertifikalı bir ters vekil koymalısın. Örnek alıcı yalnızca `127.0.0.1` üzerinde dinler.

1. Botun sunucusuna bir alan adı yönlendir (ör. `bot.example.com` -> sunucunun IP'si).
2. Caddy kur; sertifikayı otomatik alır. `/etc/caddy/Caddyfile`:

```
bot.example.com {
    @minefield path /minefield
    reverse_proxy @minefield 127.0.0.1:8787
    respond 404
}
```

3. Güvenlik duvarında 80 ve 443 portlarını aç (sertifika doğrulaması için 80 gerekir). Mümkünse 443'ü yalnızca panelin IP adresine izin verecek şekilde kısıtla; imza doğrulaması zaten korur, bu ek bir katmandır. Alıcı portunu (8787) dışarıya **açma**.
4. Panelde kullanılacak adres: `https://bot.example.com/minefield`.

### 2.5 Panel ayarları

1. Panel > Ayarlar > Bildirimler sayfasını aç.
2. Gönderim türü olarak `bot_http` seç ve adresi yapıştır: `https://bot.example.com/minefield`.
3. **Gizli anahtarı oluştur / yenile** düğmesine bas. Anahtar **yalnızca bir kez** gösterilir; hemen kopyala ve botun sunucusunda `MINEFIELD_SECRET` olarak ayarla. Anahtarı yenilediğinde eski anahtar anında geçersiz olur; botu yeni değerle yeniden başlatmalısın.
4. Hangi olayların gönderileceğini (ve hariç tutulacak sunucuları) seç, ana anahtarı aç ve kaydet.
5. **Test bildirimi gönder** düğmesine bas. Kanalında "Test bildirimi" embed'i görünmelidir; görünmezse bölüm 5'e bak.

## 3. Doğrulama algoritması

Panel her istekte şu başlıkları gönderir:

- `Content-Type: application/json`
- `X-Minefield-Timestamp`: Unix saniyesi (tamsayı)
- `X-Minefield-Signature`: `sha256=<64 küçük harf hex>`

İmza: `HMAC_SHA256(anahtar = gizli anahtar metni (UTF-8), mesaj = timestamp + "." + ham gövde baytları)`. Alıcı şunları yapmalıdır:

1. Gövdeyi **JSON'a çevirmeden önce ham bayt olarak** oku (yeniden serileştirilmiş JSON aynı baytlar değildir ve imza tutmaz).
2. Zaman damgası tamsayı değilse veya `|şimdi - ts| > 300` sn ise reddet (401).
3. İmzayı `hmac.compare_digest` ile sabit zamanlı karşılaştır; uyuşmazsa 401.
4. Ancak bundan sonra JSON'u ayrıştır, `version == 1` kontrol et; bilinmeyen `type` ve alanları yok say (yine de 2xx dön, panel tekrar denemesin).
5. `id` ile tekrarları ele (yeniden denemeler aynı `id`'yi taşır).
6. Hızlı 2xx dön, Discord'a yazmayı arka planda yap. Panel 5xx, 408 ve 429'da yeniden dener, diğer 4xx'lerde denemez.

### 3.1 Kendi kendine sınama (bilinen cevap vektörü)

Aşağıdaki betik yalnızca standart kütüphane kullanır. Alıcıdaki doğrulamayla aynı fonksiyonu içerir ve belgelenen vektörle beklenen imzayı üretmelidir. Çıktı `OK` olmalıdır.

```python
import hashlib, hmac

SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
TIMESTAMP = "1763467200"  # 2025-11-18T12:00:00Z
BODY = (
    b'{"version":1,"id":"11111111-2222-4333-8444-555555555555",'
    b'"type":"notification.test","timestamp":"2025-11-18T12:00:00.000Z",'
    b'"panel":{"name":"Minefield Panel"},"details":{"message":"Test notification"}}'
)
EXPECTED = "sha256=33b4c5de310a6a85c53094e897d2dad6853fa702f501cf8b50ad674bf2201e2d"

def sign(secret: str, ts: str, body: bytes) -> str:
    mac = hmac.new(secret.encode("utf-8"), ts.encode("ascii") + b"." + body, hashlib.sha256)
    return "sha256=" + mac.hexdigest()

assert hmac.compare_digest(sign(SECRET, TIMESTAMP, BODY), EXPECTED), "MISMATCH"
print("OK")
```

Bu vektör, panelin `signBody(secret, tsSec, bodyBuf)` birim testinde de aynen kullanılmalıdır (Node `crypto` ile de aynı imzayı üretir). `MISMATCH` alırsan anahtarı UTF-8 metin olarak değil hex-decode ederek kullanıyor olabilirsin; anahtar olduğu gibi (metin) kullanılır.

## 4. Tam alıcı kodu

Kod ve yorumlar İngilizcedir, embed metinleri Türkçedir. Dosya: `docs/examples/discord_receiver/receiver.py`.

```python
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
```

Yerel deneme (Discord'a yazmadan önce imza hattını görmek için), gizli anahtarı `MINEFIELD_SECRET` olarak ayarladıktan sonra:

```bash
BODY='{"version":1,"id":"local-1","type":"notification.test","timestamp":"2025-11-18T12:00:00.000Z","panel":{"name":"Minefield Panel"},"details":{"message":"Merhaba"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$MINEFIELD_SECRET" -hex | sed 's/^.* //')
curl -i http://127.0.0.1:8787/minefield \
  -H "X-Minefield-Timestamp: $TS" -H "X-Minefield-Signature: sha256=$SIG" \
  -H "Content-Type: application/json" --data-binary "$BODY"
```

`200 ok` ve kanalda bir embed görmelisin; imzayı bozarsan `401` dönmelidir.

## 5. Yük (payload) başvurusu, sürüm 1

```json
{
  "version": 1,
  "id": "uuid, olay başına benzersiz, yeniden denemelerde aynı",
  "type": "instance.crashed",
  "timestamp": "2025-11-18T12:00:00.000Z",
  "panel": { "name": "Minefield Panel" },
  "instance": { "daemonId": "...", "uuid": "...", "name": "Survival", "daemonName": "node-1" },
  "group": { "uuid": "...", "name": "Network", "action": "start", "runId": "..." },
  "backup": { "id": "...", "trigger": "manual", "sizeBytes": 123, "durationSec": 12 },
  "details": {}
}
```

`instance` alanı `instance.*` ve `backup.*` olaylarında, `group` alanı `group.*` olaylarında, `backup` alanı `backup.*` olaylarında bulunur. Her olaya `details.suppressedBefore` (sayı) eklenebilir. Bilinmeyen alanları yok say.

| `type` | `details` | Embed rengi |
| --- | --- | --- |
| `instance.crashed` | `exitCode` (sayı veya null), `willAutoRestart` | kırmızı |
| `instance.started` | boş | yeşil |
| `instance.stopped` | `exitCode` | gri |
| `instance.auto_restarted` | `attempt`, `maxAttempts` (null = sınırsız) | turuncu |
| `backup.succeeded` | boş (veri `backup` içinde) | yeşil |
| `backup.failed` | `reason` (en çok 200 karakter) | kırmızı |
| `group.run_started` | `memberCount` | mavi |
| `group.run_finished` | `result` (`succeeded` / `cancelled`), `memberCount`, `durationSec` | yeşil / gri |
| `group.run_failed` | `memberCount`, `durationSec`, `failedStep?` (`instanceName?`, `reason`) | kırmızı |
| `notification.test` | `message` | mavi |

## 6. Sorun giderme

| Belirti | Olası neden | Çözüm |
| --- | --- | --- |
| Alıcı `401` dönüyor (imza uyuşmuyor) | Gövde ayrıştırılıp yeniden serileştirilmiş (`json.dumps(await request.json())`). | Ham baytları (`request.content.read`) imzala; JSON'u sonra ayrıştır. |
| `401` | Yanlış veya eski gizli anahtar (yenilemeden sonra bot güncellenmedi), anahtar hex-decode edilmiş, baştaki/sondaki boşluk. | Anahtarı panelden yeniden oluştur, `MINEFIELD_SECRET`'a olduğu gibi yaz, botu yeniden başlat. 3.1'deki sınamayı çalıştır. |
| `401`, imza doğru görünüyor | Saat kayması: botun sunucusunun saati 5 dakikadan fazla sapmış. | NTP'yi etkinleştir: `timedatectl set-ntp true`, `timedatectl status` ile "System clock synchronized: yes" doğrula. |
| Panel "başarısız" gösteriyor, zaman aşımı | Alıcıya erişilemiyor (güvenlik duvarı, DNS, Caddy kapalı) veya 10 sn içinde yanıt yok. | `curl -i https://bot.example.com/minefield` ile dışarıdan dene; yanıtı Discord'u beklemeden hızlı döndürdüğünden emin ol (örnek kod kuyruğa atar). |
| Panel "başarısız": adres reddedildi | Adres özel/LAN IP'ye çözülüyor veya `http` kullanıldı. | Genel bir alan adı ve geçerli sertifikayla HTTPS kullan. |
| `200` dönüyor ama mesaj yok | Yanlış kanal kimliği, botun kanala yazma izni yok, bilinmeyen `type`. | Bot günlüğüne bak (`failed to post event`); kanal izinlerini kontrol et. |
| `413` | Gövde 64 KB üstü. | Normal olaylar 8 KB altındadır; isteğin panelden geldiğinden emin ol. |
| `503` | İç kuyruk dolu (Discord yavaş/erişilemiyor). | Panel daha sonra yeniden dener; botun Discord bağlantısını kontrol et. |
| Aynı olay iki kez geliyor | Dedupe belleği bot yeniden başlayınca sıfırlanır. | Beklenen davranış; `id` ile kalıcı dedupe istersen bir dosyada/DB'de sakla. |
