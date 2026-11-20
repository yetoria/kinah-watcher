const { chromium } = require('playwright');

const URL = 'https://ezbuff.com/aion-2-kinah';
const SERVER_NAME = 'Zemurru - Asmodians';
const TARGET_PRICE = 1.40;
const FALLBACK_USD_TO_EUR = 0.92;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = '1573349614529020025';
const ANNOUNCE_START = false;

async function getUsdToEurRate() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) return FALLBACK_USD_TO_EUR;
    const data = await res.json();
    const rate = data?.rates?.EUR;
    return typeof rate === 'number' && rate > 0 ? rate : FALLBACK_USD_TO_EUR;
  } catch {
    return FALLBACK_USD_TO_EUR;
  }
}

async function getCurrentChannelInfo() {
  const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}`, {
    headers: { 'Authorization': `Bot ${DISCORD_BOT_TOKEN}` }
  });
  if (!res.ok) return { name: null, previousPrice: null };
  const data = await res.json();
  const match = data.name?.match(/(\d+)[ed](\d{2})/);
  const previousPrice = match ? parseFloat(`${match[1]}.${match[2]}`) : null;
  return { name: data.name, previousPrice };
}

async function sendChannelMessage(content) {
  const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content })
  });
  if (!res.ok) console.warn(`⚠️ Erreur envoi message Discord (HTTP ${res.status})`);
}

async function updateChannelName(newName, currentName) {
  if (newName === currentName) return;
  const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name: newName })
  });
  if (!res.ok) console.warn(`⚠️ Erreur rename Discord (HTTP ${res.status})`);
}

async function collectCandidates(page, regex) {
  const loc = page.getByText(regex).filter({ visible: true });
  const count = await loc.count();
  const items = [];
  for (let i = 0; i < Math.min(count, 12); i++) {
    const el = loc.nth(i);
    const priceText = (await el.textContent())?.trim() ?? '';
    const parentText = (
      await el.locator('xpath=ancestor::*[self::div or self::li or self::tr or self::button][2]').textContent().catch(() => '')
    )
      ?.replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) ?? '';
    const match = priceText.match(/(\d+[.,]\d+)/);
    const value = match ? parseFloat(match[1].replace(',', '.')) : NaN;
    items.push({ priceText, value, parentText });
  }
  return items;
}

function pickBestCandidate(items) {
  const fiveMCandidate = items.find(
    (item) => !isNaN(item.value) && /\b5\s*m\b/i.test(item.parentText)
  );
  if (fiveMCandidate) {
    return { ...fiveMCandidate, matched5M: true };
  }
  const firstValid = items.find((item) => !isNaN(item.value));
  return firstValid ? { ...firstValid, matched5M: false } : null;
}

async function extractVisiblePrice(page) {
  const euroItems = await collectCandidates(page, /€\s*\d+[.,]\d+/);
  if (euroItems.length > 0) {
    console.log('Candidats € :', JSON.stringify(euroItems, null, 2));
    const chosen = pickBestCandidate(euroItems);
    if (chosen) return { ...chosen, isUsd: false };
  }

  const usdItems = await collectCandidates(page, /\$\s*\d+[.,]\d+/);
  if (usdItems.length > 0) {
    console.log('Candidats $ :', JSON.stringify(usdItems, null, 2));
    const chosen = pickBestCandidate(usdItems);
    if (chosen) return { ...chosen, isUsd: true };
  }

  const bodySnippet = (await page.locator('body').innerText().catch(() => ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  console.log('Extrait page :', bodySnippet);
  throw new Error('Aucun prix (€ ou $) trouvé sur la page');
}

async function run() {
  const { name: currentName, previousPrice } = await getCurrentChannelInfo();

  if (ANNOUNCE_START) {
    await sendChannelMessage(`🟢 **Watcher actif** — Vérification en cours pour **${SERVER_NAME}** (cible : **€${TARGET_PRICE.toFixed(2)}**).`);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris'
  });
  const page = await context.newPage();

  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    await page.getByText('Europe', { exact: true }).filter({ visible: true }).first().click().catch(() => {});
    await page.getByText('Asmodians', { exact: true }).filter({ visible: true }).first().click().catch(() => {});
    await page.getByText(SERVER_NAME, { exact: true }).filter({ visible: true }).first().click().catch(() => {});
    await page.waitForTimeout(2500);

    const extracted = await extractVisiblePrice(page);
    if (isNaN(extracted.value)) throw new Error(`Prix illisible : ${extracted.priceText}`);

    let price = extracted.value;
    if (extracted.isUsd) {
      const rate = await getUsdToEurRate();
      price = Number((extracted.value * rate).toFixed(2));
      console.log(`Conversion ${extracted.priceText} -> €${price.toFixed(2)} (taux ${rate.toFixed(4)}, matched5M=${extracted.matched5M})`);
    } else {
      console.log(`Prix direct ${extracted.priceText} -> €${price.toFixed(2)} (matched5M=${extracted.matched5M})`);
    }

    const dot = price <= TARGET_PRICE ? '🟢' : '🔴';
    const formattedPrice = price.toFixed(2).replace('.', 'e');
    const newName = `${dot}-kinah-${formattedPrice}`;
    await updateChannelName(newName, currentName);

    if (previousPrice !== null && price < previousPrice) {
      const diff = (previousPrice - price).toFixed(2);
      const alertPrefix = price <= TARGET_PRICE ? '🚨 **PRIX CIBLE ATTEINT !**' : '📉 **Baisse de prix détectée !**';
      await sendChannelMessage(
        `${alertPrefix}\nLe prix pour **5M** (${SERVER_NAME}) vient de baisser : **€${previousPrice.toFixed(2)}** ➡️ **€${price.toFixed(2)}** (-€${diff})`
      );
    } else if (newName !== currentName) {
      await sendChannelMessage(
        `📊 **Mise à jour prix** (5M — ${SERVER_NAME}) : **€${price.toFixed(2)}** (cible : **€${TARGET_PRICE.toFixed(2)}**)`
      );
    }
  } catch (err) {
    console.error('Erreur lors du check :', err.message);
    await updateChannelName('🟠-kinah-erreur', currentName);
    await sendChannelMessage(
      `🔴 **Watcher arrêté / en erreur** sur **${SERVER_NAME}** : \`${err.message}\``
    );
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

run();
