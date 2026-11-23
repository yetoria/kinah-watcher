import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || "1573349614529020025";
const IS_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === "true";

// Intervalle de refresh en secondes (ex. 900s = 15 min)
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS) || 900;

// Taux de secours si un runner US force l'affichage en $ au lieu de €
const USD_TO_EUR_RATE = Number(process.env.USD_TO_EUR_RATE) || 0.92;

// Configuration EZBUFF (prix par 5M)
const TARGET_URL = "https://www.ezbuff.com/aion-2-kinah";
const TARGET_PRICE = 1.4;
const MIN_PRICE_DELTA = 0.3;
const MIN_INTERVALS_FOR_ESTIMATE = 5;

// Configuration ELDORADO (prix par 1M, trié Cheapest first)
const ELDORADO_TARGET_PRICE = 0.25;

// Noms des salons Discord
const CHANNEL_NAME_ACTIVE = "🟢-kinah-actif";
const CHANNEL_NAME_INACTIVE = "🔴-kinah-inactif";

// Serveurs à surveiller (emojis distincts)
const SERVERS = [
  {
    key: "zemurru",
    label: "Zemurru - Asmodians",
    shortLabel: "Zemurru",
    emoji: "🌌",
    ezbuffClicks: ["Europe", "Asmodians", "Zemurru - Asmodians", "Zemurru"],
    eldoradoUrl:
      "https://www.eldorado.gg/aion-2-kinah/g/360?te_v0=Europe&te_v1=Asmodian&te_v2=Zemurru&offerSortingCriterion=Cheapest",
  },
  {
    key: "agnita",
    label: "Agnita - Asmodians",
    shortLabel: "Agnita",
    emoji: "⚡",
    ezbuffClicks: ["Europe", "Asmodians", "Agnita - Asmodians", "Agnita"],
    eldoradoUrl:
      "https://www.eldorado.gg/aion-2-kinah/g/360?te_v0=Europe&te_v1=Asmodian&te_v2=Agnita&offerSortingCriterion=Cheapest",
  },
];

const STATE_FILE = path.resolve("state.json");

if (!DISCORD_BOT_TOKEN) {
  console.error("Erreur : DISCORD_BOT_TOKEN manquant dans l'environnement.");
  process.exit(1);
}

function toEur(amount, currency) {
  const numeric = Number(amount);
  if (Number.isNaN(numeric)) return NaN;
  return currency === "$" ? numeric * USD_TO_EUR_RATE : numeric;
}

function defaultServerState() {
  return {
    lastPrice: null,
    lastSignificantPrice: null,
    lastChangeAt: null,
    intervalsMinutes: [],
    alertedDeal: false,
    eldoradoBest: null,
    eldoradoLastPrice: null,
    eldoradoAlertedDeal: false,
    lastVariationSummary: null,
  };
}

function normalizeServerState(raw = {}) {
  return {
    lastPrice: typeof raw.lastPrice === "number" ? raw.lastPrice : null,
    lastSignificantPrice:
      typeof raw.lastSignificantPrice === "number"
        ? raw.lastSignificantPrice
        : typeof raw.lastPrice === "number"
          ? raw.lastPrice
          : null,
    lastChangeAt: typeof raw.lastChangeAt === "number" ? raw.lastChangeAt : null,
    intervalsMinutes: Array.isArray(raw.intervalsMinutes)
      ? raw.intervalsMinutes.filter((n) => typeof n === "number" && n > 0)
      : [],
    alertedDeal: Boolean(raw.alertedDeal),
    eldoradoBest: raw.eldoradoBest && typeof raw.eldoradoBest === "object" ? raw.eldoradoBest : null,
    eldoradoLastPrice: typeof raw.eldoradoLastPrice === "number" ? raw.eldoradoLastPrice : null,
    eldoradoAlertedDeal: Boolean(raw.eldoradoAlertedDeal),
    lastVariationSummary:
      typeof raw.lastVariationSummary === "string"
        ? raw.lastVariationSummary
        : typeof raw.lastVariationText === "string"
          ? raw.lastVariationText
          : null,
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      const servers = parsed.servers || {};

      if (!parsed.servers && typeof parsed.lastPrice === "number") {
        servers.zemurru = normalizeServerState(parsed);
      }

      return {
        lastChannelName: typeof parsed.lastChannelName === "string" ? parsed.lastChannelName : null,
        statusMessageId: typeof parsed.statusMessageId === "string" ? parsed.statusMessageId : null,
        lastUpdatedAt: typeof parsed.lastUpdatedAt === "number" ? parsed.lastUpdatedAt : null,
        servers: {
          zemurru: normalizeServerState(servers.zemurru),
          agnita: normalizeServerState(servers.agnita),
        },
      };
    }
  } catch (err) {
    console.warn("Impossible de lire state.json, nouvel état initialisé :", err.message);
  }
  return {
    lastChannelName: null,
    statusMessageId: null,
    lastUpdatedAt: null,
    servers: {
      zemurru: defaultServerState(),
      agnita: defaultServerState(),
    },
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function formatDuration(minutes) {
  const rounded = Math.max(1, Math.round(minutes));
  if (rounded < 60) return `${rounded} min`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

function formatParisTime(ms) {
  return new Date(ms).toLocaleTimeString("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFooterTimestamp(updatedAtMs, nowMs) {
  const lastUpdateMs = typeof updatedAtMs === "number" ? updatedAtMs : nowMs;
  const nextUpdateMs = nowMs + Math.max(1, POLL_INTERVAL_SECONDS) * 1000;
  return `MAJ : ${formatParisTime(lastUpdateMs)} • Prochain : ~${formatParisTime(nextUpdateMs)}`;
}

function getMedianMinutes(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function getRemainingEstimateCompact(serverState, nowMs) {
  const count = serverState.intervalsMinutes.length;
  if (count < MIN_INTERVALS_FOR_ESTIMATE || typeof serverState.lastChangeAt !== "number") {
    return null;
  }

  const typicalInterval = getMedianMinutes(serverState.intervalsMinutes);
  const elapsedMinutes = Math.max(0, (nowMs - serverState.lastChangeAt) / 60000);
  const remainingMinutes = typicalInterval - elapsedMinutes;

  if (remainingMinutes <= 2) {
    return `changement imminent (~${formatDuration(typicalInterval)})`;
  }

  return `prochain ~${formatDuration(remainingMinutes)}`;
}

async function discordRequest(endpoint, method = "GET", body = null) {
  const res = await fetch(`https://discord.com/api/v10${endpoint}`, {
    method,
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (https://github.com/yetoria/kinah-watcher, 1.0)",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Discord API ${method} ${endpoint} -> ${res.status} : ${text}`);
    err.status = res.status;
    throw err;
  }

  if (res.status === 204) return null;
  return res.json();
}

async function getChannel() {
  return discordRequest(`/channels/${CHANNEL_ID}`, "GET");
}

async function renameChannel(newName, state) {
  if (state.lastChannelName === newName) return;
  await discordRequest(`/channels/${CHANNEL_ID}`, "PATCH", { name: newName });
  state.lastChannelName = newName;
}

async function sendDiscordMessage(content) {
  const payload = { content };
  if (content.includes("@everyone")) {
    payload.allowed_mentions = { parse: ["everyone"] };
  }
  return discordRequest(`/channels/${CHANNEL_ID}/messages`, "POST", payload);
}

async function upsertStatusEmbed(embed, state) {
  const body = {
    content: "",
    embeds: [embed],
  };

  if (state.statusMessageId) {
    try {
      await discordRequest(`/channels/${CHANNEL_ID}/messages/${state.statusMessageId}`, "PATCH", body);
      return;
    } catch (err) {
      if (err.status !== 404) {
        throw err;
      }
      console.warn("Message d'embed introuvable (404), création d'un nouveau message.");
      state.statusMessageId = null;
    }
  }

  const created = await discordRequest(`/channels/${CHANNEL_ID}/messages`, "POST", body);
  if (created?.id) {
    state.statusMessageId = created.id;
  }
}

function buildStatusEmbed(state, nowMs) {
  const hasAnyActiveDeal = SERVERS.some((server) => {
    const s = state.servers[server.key];
    return (
      s.alertedDeal ||
      s.eldoradoAlertedDeal ||
      (typeof s.lastPrice === "number" && s.lastPrice <= TARGET_PRICE) ||
      (s.eldoradoBest && Number(s.eldoradoBest.price) <= ELDORADO_TARGET_PRICE)
    );
  });

  const fields = SERVERS.map((server) => {
    const s = state.servers[server.key];

    const stableMin =
      typeof s.lastChangeAt === "number" ? Math.max(0, (nowMs - s.lastChangeAt) / 60000) : null;
    const activeTag =
      stableMin !== null && stableMin >= 15
        ? ` • *offre active depuis ${formatDuration(stableMin)}*`
        : "";

    const ezbuffLine =
      typeof s.lastPrice === "number"
        ? `**EZBUFF :** \`${s.lastPrice.toFixed(2)} € / 5M\` *(${(s.lastPrice / 5).toFixed(3)} € / M)*${activeTag}`
        : `**EZBUFF :** *Indisponible*`;

    const eldoradoLine = s.eldoradoBest
      ? `**Eldorado :** \`${(Number(s.eldoradoBest.price) * 5).toFixed(2)} € / 5M\` *(${Number(s.eldoradoBest.price).toFixed(3)} € / M — [${s.eldoradoBest.seller}](${server.eldoradoUrl}))*`
      : `**Eldorado :** *Indisponible*`;

    return {
      name: `${server.emoji} ${server.label}`,
      value: `${ezbuffLine}\n${eldoradoLine}`,
      inline: false,
    };
  });

  const movementLines = SERVERS.map((server) => {
    const s = state.servers[server.key];
    if (!s.lastVariationSummary) return null;
    return `• ${server.emoji} **${server.shortLabel} :** ${s.lastVariationSummary}`;
  }).filter(Boolean);

  if (movementLines.length > 0) {
    fields.push({
      name: "──────────────────────────────\n📊 Derniers mouvements",
      value: movementLines.join("\n"),
      inline: false,
    });
  }

  return {
    title: "🛡️ Bot Kinah — Surveillance active",
    color: hasAnyActiveDeal ? 0x2ecc71 : 0x3498db,
    fields,
    footer: {
      text: formatFooterTimestamp(state.lastUpdatedAt, nowMs),
    },
    timestamp: new Date(nowMs).toISOString(),
  };
}

async function extractEzbuffPrices(page, serverNameRegex) {
  return page.evaluate((regexSource) => {
    const serverRegex = new RegExp(regexSource, "i");
    const bodyText = document.body.innerText || "";
    const has5MText = /\b5\s*m\b/i.test(bodyText);
    const hasServer = serverRegex.test(bodyText);

    const elements = Array.from(document.querySelectorAll("body *"));
    const candidates = [];

    for (const el of elements) {
      if (el.children.length > 0) continue;
      const text = (el.textContent || "").trim();
      const match = text.match(/([€$])\s*(\d+(?:[.,]\d{1,2})?)/);
      if (!match) continue;

      const currency = match[1];
      const rawValue = parseFloat(match[2].replace(",", "."));
      if (Number.isNaN(rawValue) || rawValue <= 0 || rawValue > 1000) continue;

      let container = el.parentElement;
      let contextText = text;
      for (let i = 0; i < 5 && container; i++) {
        const t = (container.innerText || "").replace(/\s+/g, " ").trim();
        if (t.length > contextText.length && t.length < 400) {
          contextText = t;
        }
        if (/\b5\s*m\b/i.test(t) || serverRegex.test(t)) {
          contextText = t;
          break;
        }
        container = container.parentElement;
      }

      const local5M = /\b5\s*m\b/i.test(contextText);
      const localServer = serverRegex.test(contextText);
      candidates.push({
        priceText: match[0],
        currency,
        rawValue,
        local5M,
        localServer,
        contextText,
      });
    }

    const preferredEurBoth = candidates.find((c) => c.currency === "€" && c.local5M && c.localServer);
    const preferredBoth = candidates.find((c) => c.local5M && c.localServer);
    const preferredEur5M = candidates.find((c) => c.currency === "€" && c.local5M);
    const preferred5M = candidates.find((c) => c.local5M);
    const best =
      preferredEurBoth ||
      preferredBoth ||
      preferredEur5M ||
      preferred5M ||
      (candidates.length > 0 ? candidates[0] : null);
    const matched5M = Boolean(preferredEurBoth || preferredBoth || preferredEur5M || preferred5M || has5MText);

    return {
      hasServer,
      has5MText,
      candidates,
      best,
      matched5M,
    };
  }, serverNameRegex);
}

async function scrapeEzbuffPrice(browser, server) {
  const context = await browser.newContext({
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
  });
  const page = await context.newPage();
  try {
    await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 45000 }).catch(async () => {
      await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    });

    await page
      .waitForFunction(() => /[€$]\s*\d+/.test(document.body.innerText || ""), {
        timeout: 20000,
      })
      .catch(() => {});

    const clickIfVisible = async (label) => {
      const locator = page.getByText(label, { exact: false }).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.click().catch(() => {});
        await page.waitForTimeout(1000);
      }
    };

    for (const label of server.ezbuffClicks) {
      await clickIfVisible(label);
    }
    await page.waitForTimeout(1500);

    const serverRegex = `${server.key}\\s*-\\s*asmodians|${server.key}`;
    let data = await extractEzbuffPrices(page, serverRegex);
    if (!data.best) {
      await page.waitForTimeout(3000);
      data = await extractEzbuffPrices(page, serverRegex);
    }

    if (!data.best) {
      throw new Error(`Aucun prix détecté sur EZBUFF pour ${server.label}.`);
    }

    const eurPrice = Number(toEur(data.best.rawValue, data.best.currency).toFixed(2));
    console.log(
      `[EZBUFF - ${server.label}] ${data.best.priceText} -> €${eurPrice.toFixed(2)} (raw=${data.best.rawValue}${data.best.currency}, matched5M=${data.matched5M})`
    );

    return {
      price: eurPrice,
      matched5M: data.matched5M,
    };
  } finally {
    await context.close();
  }
}

async function scrapeEldoradoPrice(browser, server) {
  const context = await browser.newContext({
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto(server.eldoradoUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    const cheapestBtn = page.getByRole("button", { name: /Cheapest first/i }).first();
    if (await cheapestBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
      await cheapestBtn.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    await page
      .waitForFunction(() => /[€$]\s*\d+[.,]\d+\s*\/\s*M/i.test(document.body.innerText || ""), {
        timeout: 20000,
      })
      .catch(() => {});

    const offers = await page.evaluate(() => {
      const results = [];
      const nodes = Array.from(document.querySelectorAll("a, div, li")).filter((el) =>
        /[€$]\s*\d+[.,]\d+\s*\/\s*M/i.test(el.innerText || "")
      );

      for (const el of nodes) {
        const text = (el.innerText || "").trim();
        if (text.length > 500) continue;

        const priceMatch = text.match(/([€$])\s*(\d+[.,]\d+)\s*\/\s*M/i);
        if (!priceMatch) continue;

        const currency = priceMatch[1];
        const rawPrice = parseFloat(priceMatch[2].replace(",", "."));
        if (Number.isNaN(rawPrice) || rawPrice <= 0) continue;

        const stockMatch = text.match(/In stock\s*\n?\s*([\d,]+)\s*M/i);
        const minMatch = text.match(/Min\.\s*qty\.\s*\n?\s*([\d,]+)\s*M/i);
        const seller = text.split("\n")[0]?.trim() || "Inconnu";

        if (stockMatch && minMatch) {
          results.push({
            seller,
            currency,
            rawPrice,
            stock: stockMatch[1],
            minQty: minMatch[1],
          });
        }
      }

      const unique = Array.from(
        new Map(results.map((r) => [`${r.seller}-${r.currency}-${r.rawPrice}`, r])).values()
      );
      return unique.sort((a, b) => a.rawPrice - b.rawPrice);
    });

    if (!offers.length) {
      console.warn(`[Eldorado - ${server.label}] Aucune offre structurée détectée.`);
      return null;
    }

    const bestRaw = offers[0];
    const eurPrice = Number(toEur(bestRaw.rawPrice, bestRaw.currency).toFixed(3));
    const best = {
      seller: bestRaw.seller,
      price: eurPrice,
      stock: bestRaw.stock,
      minQty: bestRaw.minQty,
    };

    console.log(
      `[Eldorado - ${server.label}] Cheapest -> €${best.price}/M (${bestRaw.currency}${bestRaw.rawPrice}/M, ${best.seller} | Stock: ${best.stock}M | Min: ${best.minQty}M)`
    );
    return best;
  } finally {
    await context.close();
  }
}

async function run() {
  const state = loadState();
  const nowMs = Date.now();
  const browser = await chromium.launch({ headless: true });

  try {
    const channel = await getChannel();
    if (!state.lastChannelName && channel?.name) {
      state.lastChannelName = channel.name;
    }

    await renameChannel(CHANNEL_NAME_ACTIVE, state);

    for (const server of SERVERS) {
      const serverState = state.servers[server.key];

      // 1. Vérification EZBUFF
      const { price, matched5M } = await scrapeEzbuffPrice(browser, server);
      const pricePerM = price / 5;

      // 2. Vérification ELDORADO
      try {
        const eldoradoBest = await scrapeEldoradoPrice(browser, server);
        if (eldoradoBest) {
          serverState.eldoradoBest = eldoradoBest;
        }
      } catch (eldoradoErr) {
        console.warn(`[Eldorado - ${server.label}] Échec temporaire :`, eldoradoErr.message);
      }

      // 3. Suivi des variations EZBUFF
      if (typeof serverState.lastSignificantPrice !== "number") {
        serverState.lastSignificantPrice = price;
      }

      if (typeof serverState.lastChangeAt !== "number") {
        serverState.lastChangeAt = nowMs;
      } else {
        const delta = price - serverState.lastSignificantPrice;
        const absDelta = Number(Math.abs(delta).toFixed(4));

        if (absDelta >= MIN_PRICE_DELTA) {
          const stableDurationText = formatDuration((nowMs - serverState.lastChangeAt) / 60000);
          const elapsedMin = Number(((nowMs - serverState.lastChangeAt) / 60000).toFixed(1));
          if (elapsedMin > 0) {
            serverState.intervalsMinutes.push(elapsedMin);
            if (serverState.intervalsMinutes.length > 50) {
              serverState.intervalsMinutes = serverState.intervalsMinutes.slice(-50);
            }
          }

          const directionLabel = delta < 0 ? "📉 Baisse EZBUFF" : "📈 Hausse EZBUFF";
          const estimateCompact = getRemainingEstimateCompact(serverState, nowMs);
          const metaParts = [`stable ${stableDurationText}`];
          if (estimateCompact) metaParts.push(estimateCompact);

          serverState.lastVariationSummary = `${directionLabel} \`${serverState.lastSignificantPrice.toFixed(2)} → ${price.toFixed(2)} € / 5M\` *(${metaParts.join(" • ")})*`;

          serverState.lastSignificantPrice = price;
          serverState.lastChangeAt = nowMs;
        }
      }

      const isTargetDeal = price <= TARGET_PRICE && matched5M === true;
      if (isTargetDeal && !serverState.alertedDeal) {
        await sendDiscordMessage(
          `@everyone 🚨 **Deal EZBUFF ≤ ${TARGET_PRICE.toFixed(2)} € / 5M** *(${(TARGET_PRICE / 5).toFixed(3)} € / M)* sur ${server.emoji} **${server.label}** : \`${price.toFixed(2)} € / 5M\` *(${pricePerM.toFixed(3)} € / M)* !`
        );
        serverState.alertedDeal = true;
      } else if (!isTargetDeal) {
        serverState.alertedDeal = false;
      }

      serverState.lastPrice = price;

      // 4. Suivi des deals ELDORADO
      const eldoradoBest = serverState.eldoradoBest;
      if (eldoradoBest) {
        const prevEldorado = serverState.eldoradoLastPrice;
        serverState.eldoradoLastPrice = eldoradoBest.price;

        const isEldoradoDeal = eldoradoBest.price <= ELDORADO_TARGET_PRICE;
        const droppedFurther = prevEldorado !== null && eldoradoBest.price < prevEldorado;

        if (isEldoradoDeal && (!serverState.eldoradoAlertedDeal || droppedFurther)) {
          await sendDiscordMessage(
            `@everyone 🚨 **Deal Eldorado ≤ ${ELDORADO_TARGET_PRICE.toFixed(3)} € / M** sur ${server.emoji} **${server.label}** !\n` +
              `• Prix cheapest : \`${(eldoradoBest.price * 5).toFixed(2)} € / 5M\` *(${eldoradoBest.price.toFixed(3)} € / M)*\n` +
              `• Vendeur : **${eldoradoBest.seller}** (Stock : ${eldoradoBest.stock}M | Min : ${eldoradoBest.minQty}M)\n` +
              `• Lien : <${server.eldoradoUrl}>`
          );
          serverState.eldoradoAlertedDeal = true;
        } else if (!isEldoradoDeal) {
          serverState.eldoradoAlertedDeal = false;
        }
      }
    }

    state.lastUpdatedAt = nowMs;

    // 5. Mise à jour de l'embed unique sur Discord
    const embed = buildStatusEmbed(state, nowMs);
    await upsertStatusEmbed(embed, state);

    if (IS_GITHUB_ACTIONS) {
      await renameChannel(CHANNEL_NAME_INACTIVE, state);
    }

    saveState(state);
  } catch (err) {
    console.error("Erreur watcher :", err.message);
    try {
      await renameChannel("🟠-kinah-erreur", state);
      await upsertStatusEmbed(
        {
          title: "⚠️ Bot Kinah — Erreur",
          color: 0xe67e22,
          description: `\`${err.message.slice(0, 1500)}\``,
          footer: {
            text: formatFooterTimestamp(state.lastUpdatedAt, nowMs),
          },
          timestamp: new Date(nowMs).toISOString(),
        },
        state
      );
      saveState(state);
    } catch (discordErr) {
      console.error("Impossible de notifier l'erreur sur Discord :", discordErr.message);
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

run();
