import { describe, expect, it } from "vitest";
import {
  isBlockedAddress,
  makePinnedLookup,
  OutboundUrlError,
  resolveOutboundTarget,
  validateOutboundUrl
} from "../outbound_url";

const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKLmnopqrstuvwxyz0123";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e: any) {
    return e.code;
  }
  return undefined;
}
async function asyncCodeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e: any) {
    return e.code as string;
  }
  return undefined;
}
const stub = (answers: { address: string; family: number }[]) => async () => answers;

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.1",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.5",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "febf::1",
    "ff02::1",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:c0a8:101",
    "::7f00:1",
    "64:ff9b::a00:1",
    "64:ff9b::7f00:1",
    "2002:0a00:0001::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "not-an-ip"
  ])("blocks %s", (addr) => {
    expect(isBlockedAddress(addr)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "198.17.0.1",
    "198.20.0.1",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808"
  ])("allows %s", (addr) => {
    expect(isBlockedAddress(addr)).toBe(false);
  });
});

describe("validateOutboundUrl", () => {
  const bot = { allowPrivate: false, sinkType: "bot_http" as const };
  it("accepts a plain https bot url", () => {
    expect(validateOutboundUrl("https://bot.example.com/minefield", bot).hostname).toBe(
      "bot.example.com"
    );
  });
  it("rejects bad input", () => {
    expect(codeOf(() => validateOutboundUrl("", bot))).toBe("invalid_url");
    expect(codeOf(() => validateOutboundUrl(42, bot))).toBe("invalid_url");
    expect(codeOf(() => validateOutboundUrl("nope", bot))).toBe("invalid_url");
    expect(codeOf(() => validateOutboundUrl("https://a.example/#x", bot))).toBe("invalid_url");
    expect(codeOf(() => validateOutboundUrl("https://u:p@a.example/", bot))).toBe("credentials");
    expect(codeOf(() => validateOutboundUrl("ftp://a.example/", bot))).toBe("scheme");
    expect(codeOf(() => validateOutboundUrl("https://a.example:70000/", bot))).toBe("invalid_url");
    expect(codeOf(() => validateOutboundUrl("https://a.example/" + "a".repeat(600), bot))).toBe(
      "too_long"
    );
  });
  it("requires https unless allowPrivate", () => {
    expect(codeOf(() => validateOutboundUrl("http://192.168.1.20:8080/hook", bot))).toBe("scheme");
    expect(
      validateOutboundUrl("http://192.168.1.20:8080/hook", { ...bot, allowPrivate: true }).port
    ).toBe("8080");
  });
  it("restricts webhooks to Discord hosts and the webhook path", () => {
    const hook = { allowPrivate: false, sinkType: "discord_webhook" as const };
    expect(validateOutboundUrl(WEBHOOK, hook).host).toBe("discord.com");
    for (const h of ["canary.discord.com", "ptb.discord.com", "discordapp.com"])
      expect(() => validateOutboundUrl(WEBHOOK.replace("discord.com", h), hook)).not.toThrow();
    expect(codeOf(() => validateOutboundUrl(WEBHOOK.replace("discord.com", "evil.com"), hook))).toBe(
      "host_not_allowed"
    );
    expect(
      codeOf(() => validateOutboundUrl(WEBHOOK.replace("discord.com", "discord.com.evil.com"), hook))
    ).toBe("host_not_allowed");
    expect(codeOf(() => validateOutboundUrl(WEBHOOK.replace("https", "http"), hook))).toBe("scheme");
    expect(codeOf(() => validateOutboundUrl("https://discord.com/api/other", hook))).toBe("path");
    expect(codeOf(() => validateOutboundUrl(WEBHOOK + "?x=1", hook))).toBe("path");
    expect(codeOf(() => validateOutboundUrl(WEBHOOK.replace("discord.com", "discord.com:8443"), hook))).toBe("port");
    // allowPrivate is irrelevant to webhooks
    expect(codeOf(() => validateOutboundUrl("http://discord.com/api/webhooks/1/2", { ...hook, allowPrivate: true }))).toBe("scheme");
  });
});

describe("resolveOutboundTarget", () => {
  const bot = { allowPrivate: false, sinkType: "bot_http" as const };
  it("returns the validated public address", async () => {
    const t = await resolveOutboundTarget(
      "https://bot.example.com/x",
      bot,
      stub([{ address: "93.184.216.34", family: 4 }])
    );
    expect(t.address).toBe("93.184.216.34");
    expect(t.family).toBe(4);
    expect(t.port).toBe(443);
    expect(t.allPrivate).toBe(false);
  });
  it("refuses private answers, including a mixed answer set", async () => {
    expect(
      await asyncCodeOf(
        resolveOutboundTarget("https://a.example/", bot, stub([{ address: "10.0.0.5", family: 4 }]))
      )
    ).toBe("blocked_address");
    expect(
      await asyncCodeOf(
        resolveOutboundTarget(
          "https://a.example/",
          bot,
          stub([
            { address: "8.8.8.8", family: 4 },
            { address: "127.0.0.1", family: 4 }
          ])
        )
      )
    ).toBe("blocked_address");
  });
  it("classifies IP literals without DNS", async () => {
    const never = async () => {
      throw new Error("resolver must not be used");
    };
    expect(await asyncCodeOf(resolveOutboundTarget("https://127.0.0.1/", bot, never))).toBe("blocked_address");
    expect(await asyncCodeOf(resolveOutboundTarget("https://[::1]/", bot, never))).toBe("blocked_address");
    expect(await asyncCodeOf(resolveOutboundTarget("https://[::ffff:10.0.0.1]/", bot, never))).toBe("blocked_address");
    expect(await asyncCodeOf(resolveOutboundTarget("https://2130706433/", bot, never))).toBe("blocked_address");
    expect((await resolveOutboundTarget("https://8.8.8.8/", bot, never)).address).toBe("8.8.8.8");
    expect((await resolveOutboundTarget("https://[2606:4700:4700::1111]/", bot, never)).family).toBe(6);
  });
  it("maps resolver failure to dns", async () => {
    const fail = async () => {
      throw new Error("ENOTFOUND secret-host");
    };
    expect(await asyncCodeOf(resolveOutboundTarget("https://a.example/", bot, fail))).toBe("dns");
    expect(await asyncCodeOf(resolveOutboundTarget("https://a.example/", bot, stub([])))).toBe("dns");
  });
  it("allowPrivate permits private https and http only for fully private targets", async () => {
    const priv = { allowPrivate: true, sinkType: "bot_http" as const };
    const t = await resolveOutboundTarget("http://192.168.1.20:8080/hook", priv);
    expect(t.address).toBe("192.168.1.20");
    expect(t.port).toBe(8080);
    expect(t.allPrivate).toBe(true);
    // http to a public address stays refused even with allowPrivate
    expect(
      await asyncCodeOf(
        resolveOutboundTarget("http://a.example/", priv, stub([{ address: "8.8.8.8", family: 4 }]))
      )
    ).toBe("scheme");
    // mixed answers are not "fully private"
    expect(
      await asyncCodeOf(
        resolveOutboundTarget(
          "http://a.example/",
          priv,
          stub([
            { address: "10.0.0.1", family: 4 },
            { address: "8.8.8.8", family: 4 }
          ])
        )
      )
    ).toBe("scheme");
    expect((await resolveOutboundTarget("https://10.0.0.1/", priv)).allPrivate).toBe(true);
  });
  it("ignores allowPrivate for the Discord webhook sink", async () => {
    const hook = { allowPrivate: true, sinkType: "discord_webhook" as const };
    expect(
      await asyncCodeOf(
        resolveOutboundTarget(WEBHOOK, hook, stub([{ address: "10.0.0.1", family: 4 }]))
      )
    ).toBe("blocked_address");
  });
  it("only consults the resolver once (the caller pins the result)", async () => {
    let calls = 0;
    const answers = [
      [{ address: "8.8.8.8", family: 4 }],
      [{ address: "127.0.0.1", family: 4 }]
    ];
    const t = await resolveOutboundTarget("https://a.example/", bot, async () => answers[calls++]);
    expect(calls).toBe(1);
    expect(t.address).toBe("8.8.8.8");
  });
  it("errors carry only a code", async () => {
    try {
      await resolveOutboundTarget("https://u:pw@a.example/secret", bot);
    } catch (e: any) {
      expect(e).toBeInstanceOf(OutboundUrlError);
      expect(e.message).toBe("credentials");
    }
  });
});

describe("makePinnedLookup", () => {
  it("answers in both call styles with the validated address", () => {
    const lookup = makePinnedLookup("8.8.8.8", 4);
    let single: any[] = [];
    lookup("x.example", {}, (...a) => (single = a));
    expect(single).toEqual([null, "8.8.8.8", 4]);
    let all: any[] = [];
    lookup("x.example", { all: true }, (...a) => (all = a));
    expect(all).toEqual([null, [{ address: "8.8.8.8", family: 4 }]]);
  });
});
