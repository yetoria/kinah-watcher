const { chromium } = require('playwright');

const URL = 'https://ezbuff.com/aion-2-kinah';
const SERVER_NAME = 'Zemurru - Asmodians';
const TARGET_PRICE = 1.40;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = '1573349614529020025';

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
  await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content })
  });
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

    const eurBtn = page.locator('text=/EUR|€/').filter({ visible: true }).first();
    if (await eurBtn.count() > 0 && !(await page.locator('text=/€\\s*\\d+\\.\\d+/').filter({ visible: true }).count())) {
      await eurBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    const priceLocator = page.locator('text=/[€$]\\s*\\d+\\.\\d+/').filter({ visible: true }).first();
    const priceText = await priceLocator.textContent();
    const isDollar = priceText.includes('$');
    const currencySymbol = isDollar ? '$' : '€';
    const currencyLetter = isDollar ? 'd' : 'e';
    const price = parseFloat(priceText.replace(/[€$]/g, '').trim());

    if (isNaN(price)) throw new Error(`Prix illisible : ${priceText}`);

    console.log(`Prix actuel (5M) : ${currencySymbol}${price} (précédent : ${previousPrice ?? 'inconnu'})`);

    const dot = price <= TARGET_PRICE ? '🟢' : '🔴';
    const formattedPrice = price.toFixed(2).replace('.', currencyLetter);
    await updateChannelName(`${dot}-kinah-${formattedPrice}`, currentName);

    if (previousPrice !== null && price < previousPrice) {
      const diff = (previousPrice - price).toFixed(2);
      const alertPrefix = price <= TARGET_PRICE ? '🚨 **PRIX CIBLE ATTEINT !**' : '📉 **Baisse de prix détectée !**';
      await sendChannelMessage(
        `${alertPrefix}\nLe prix pour **5M** (${SERVER_NAME}) vient de baisser : **${currencySymbol}${previousPrice.toFixed(2)}** ➡️ **${currencySymbol}${price.toFixed(2)}** (-${currencySymbol}${diff})\n👉 ${URL}`
      );
    }
  } catch (err) {
    console.error('Erreur lors du check :', err.message);
    await updateChannelName('🟠-kinah-erreur', currentName);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

run();
