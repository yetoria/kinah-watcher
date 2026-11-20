const { chromium } = require('playwright');

const URL = 'https://ezbuff.com/aion-2-kinah';
const SERVER_NAME = 'Zemurru - Asmodians';
const TARGET_PRICE = 1.40;
const FALLBACK_USD_TO_EUR = 0.92;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = '1573349614529020025';
const ANNOUNCE_START = true;

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
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.getByText('Europe', { exact: true }).filter({ visible: true }).click();
    await page.getByText('Asmodians', { exact: true }).filter({ visible: true }).click();
    await page.getByText(SERVER_NAME, { exact: true }).filter({ visible: true }).click();
    await page.waitForTimeout(2000);

    const hasEuro = await page.locator('text=/€\\s*\\d+\\.\\d+/').filter({ visible: true }).count();
    if (!hasEuro) {
      const eurSwitcher = page.locator('button, div, span, a').filter({ hasText: /^EUR$|^€$/ }).filter({ visible: true }).first();
      if (await eurSwitcher.count() > 0) {
        await eurSwitcher.click().catch(() => {});
        await page.waitForTimeout(1500);
      }
    }

    const euroLocator = page.locator('text=/€\\s*\\d+\\.\\d+/').filter({ visible: true }).first();
    const dollarLocator = page.locator('text=/\\$\\s*\\d+\\.\\d+/').filter({ visible: true }).first();

    let rawPrice;
    let price;

    if (await euroLocator.count() > 0) {
      const priceText = await euroLocator.textContent();
      rawPrice = parseFloat(priceText.replace('€', '').trim());
      price = rawPrice;
    } else if (await dollarLocator.count() > 0) {
      const priceText = await dollarLocator.textContent();
      rawPrice = parseFloat(priceText.replace('$', '').trim());
      const rate = await getUsdToEurRate();
      price = Number((rawPrice * rate).toFixed(2));
      console.log(`Converti $${rawPrice.toFixed(2)} -> €${price.toFixed(2)} (taux ${rate.toFixed(4)})`);
    } else {
      throw new Error('Aucun prix (€ ou $) trouvé sur la page');
    }

    if (isNaN(price)) throw new Error('Prix illisible');

    console.log(`Prix actuel (5M) : €${price.toFixed(2)} (précédent : ${previousPrice ?? 'inconnu'})`);

    const dot = price <= TARGET_PRICE ? '🟢' : '🔴';
    const formattedPrice = price.toFixed(2).replace('.', 'e');
    await updateChannelName(`${dot}-kinah-${formattedPrice}`, currentName);

    if (previousPrice !== null && price < previousPrice) {
      const diff = (previousPrice - price).toFixed(2);
      const alertPrefix = price <= TARGET_PRICE ? '🚨 **PRIX CIBLE ATTEINT !**' : '📉 **Baisse de prix détectée !**';
      await sendChannelMessage(
        `${alertPrefix}\nLe prix pour **5M** (${SERVER_NAME}) vient de baisser : **€${previousPrice.toFixed(2)}** ➡️ **€${price.toFixed(2)}** (-€${diff})\n👉 ${URL}`
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
