// scraper.js
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://peskgames.com";
const OUTPUT = path.join(__dirname, "games_data.json");
const NAV_TIMEOUT = 60000;
const BETWEEN_GAMES = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slugify(t) {
  return (t || "").toLowerCase().replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function hostFrom(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "Direct"; }
}

async function stealthPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 900 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.chrome = { runtime: {} };
  });
  return page;
}

async function autoScroll(page) {
  await page.evaluate(() => new Promise((resolve) => {
    let y = 0;
    const iv = setInterval(() => { window.scrollBy(0, 500); y += 500; if (y >= document.body.scrollHeight) { clearInterval(iv); resolve(); } }, 150);
    setTimeout(() => { clearInterval(iv); resolve(); }, 15000);
  }));
}

function parseRequirements(text) {
  const r = { minimum: { os:"",cpu:"",ram:"",gpu:"",storage:"",directx:"" }, recommended: { os:"",cpu:"",ram:"",gpu:"",storage:"",directx:"" } };
  const extract = (chunk) => {
    const g = (rx) => { const m = chunk.match(rx); return m ? m[1].split("\n")[0].trim() : ""; };
    return { os:g(/os\s*[:\-–]\s*(.+)/i), cpu:g(/(?:processor|cpu)\s*[:\-–]\s*(.+)/i), ram:g(/(?:memory|ram)\s*[:\-–]\s*(.+)/i), gpu:g(/(?:graphics|gpu|video)\s*[:\-–]\s*(.+)/i), storage:g(/(?:storage|disk|hdd|free\s*space)\s*[:\-–]\s*(.+)/i), directx:g(/directx\s*[:\-–]\s*(.+)/i) };
  };
  const mi = text.search(/minimum\s*(system\s*)?req/i);
  const ri = text.search(/recommended\s*(system\s*)?req/i);
  if (mi !== -1 && ri !== -1 && mi < ri) { r.minimum = extract(text.slice(mi, ri)); r.recommended = extract(text.slice(ri, ri + 1500)); }
  else if (mi !== -1) r.minimum = extract(text.slice(mi, mi + 1500));
  else if (ri !== -1) r.recommended = extract(text.slice(ri, ri + 1500));
  return r;
}

// ═════════════════════════════════════════════════════════════
//  STEP 1 — Collect game URLs from /en/pc-games/ + pagination
// ═════════════════════════════════════════════════════════════
async function collectGameUrls(browser) {
  console.log("📋 Collecting game URLs from /en/pc-games/ …");
  const page = await stealthPage(browser);
  const allUrls = new Set();

  try {
    let pageNum = 1;

    while (true) {
      const listUrl = pageNum === 1
        ? `${BASE_URL}/en/pc-games/`
        : `${BASE_URL}/en/pc-games/page/${pageNum}`;

      console.log(`   page ${pageNum}: ${listUrl}`);

      const response = await page.goto(listUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT }).catch(() => null);

      // If page doesn't exist or redirects away, stop pagination
      if (!response || response.status() >= 400) {
        console.log(`   → page ${pageNum} returned ${response?.status() || "no response"}, stopping`);
        break;
      }

      // Check if we got redirected away from the games list
      const currentUrl = page.url();
      if (pageNum > 1 && !currentUrl.includes("/pc-games/")) {
        console.log(`   → redirected to ${currentUrl}, stopping`);
        break;
      }

      await autoScroll(page);
      await sleep(1000);

      // Extract game links: /en/pc-games/SLUG (not /page/N)
      const urls = await page.evaluate(() => {
        const found = [];
        document.querySelectorAll("a[href]").forEach((a) => {
          const href = a.href;
          // Match: /en/pc-games/some-game-slug
          // Exclude: /en/pc-games/  (category itself)
          //          /en/pc-games/page/N  (pagination)
          const m = href.match(/\/en\/pc-games\/([^/?#]+)\/?$/);
          if (m && m[1] && !m[1].startsWith("page")) {
            found.push(href.replace(/\/+$/, ""));
          }
        });
        return found;
      });

      const before = allUrls.size;
      urls.forEach((u) => allUrls.add(u));
      const newCount = allUrls.size - before;
      console.log(`   → found ${urls.length} links, ${newCount} new (total: ${allUrls.size})`);

      // If no new games found, stop
      if (newCount === 0 && pageNum > 1) {
        console.log(`   → no new games, stopping pagination`);
        break;
      }

      // Check if there's a next page link
      const hasNext = await page.evaluate((num) => {
        const nextUrl = `/en/pc-games/page/${num + 1}`;
        return !!document.querySelector(`a[href*="${nextUrl}"]`);
      }, pageNum);

      if (!hasNext) {
        console.log(`   → no link to page ${pageNum + 1}, stopping`);
        break;
      }

      pageNum++;
      await sleep(1500);
    }

    const result = [...allUrls];
    console.log(`\n   ✅ Total: ${result.length} game URL(s)\n`);
    return result;
  } finally {
    await page.close();
  }
}

// ═════════════════════════════════════════════════════════════
//  STEP 2 — Scrape one game page + get download link
// ═════════════════════════════════════════════════════════════
async function scrapeGame(browser, gameUrl) {
  const page = await stealthPage(browser);

  try {
    await page.goto(gameUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });
    await autoScroll(page);
    await sleep(1000);

    // ── Extract metadata ────────────────────────────────────
    const raw = await page.evaluate(() => {
      const body = document.body.innerText || "";
      const pick = (...ss) => {
        for (const s of ss) {
          const el = document.querySelector(s);
          if (el?.textContent?.trim()) return el.textContent.trim();
        }
        return "";
      };

      let title = pick("h1", "h2", ".entry-title", ".post-title");
      if (!title) title = document.title.split(/[|\-–]/)[0].trim();

      let coverImage = "";
      const imgs = document.querySelectorAll("img");
      for (const img of imgs) {
        const src = img.src || img.dataset.src || "";
        if (src && (img.naturalWidth > 200 || img.width > 200)) {
          coverImage = src;
          break;
        }
      }

      const images = [];
      document.querySelectorAll("img").forEach((img) => {
        const src = img.src || img.dataset.src;
        if (src && !images.includes(src) && (img.naturalWidth > 100 || img.width > 100)) {
          images.push(src);
        }
      });

      let description = "";
      // Try common containers
      for (const sel of [".entry-content",".post-content",".game-description","article",".content"]) {
        const el = document.querySelector(sel);
        if (el) {
          const t = el.innerText.trim();
          if (t.length > description.length) description = t;
        }
      }
      // Fallback: all paragraphs
      if (!description) {
        description = [...document.querySelectorAll("p")]
          .map((p) => p.textContent.trim())
          .filter((t) => t.length > 20)
          .join("\n\n");
      }

      const grab = (rx) => { const m = body.match(rx); return m ? m[1].split("\n")[0].trim() : ""; };
      const fsM = body.match(/([\d.,]+)\s*(GB|MB|TB)/i);

      // Check if download_link button exists
      const hasDownloadBtn = !!document.querySelector("button.download_link");

      return {
        title,
        coverImage,
        images,
        description,
        fileSize: fsM ? `${fsM[1]} ${fsM[2].toUpperCase()}` : "",
        genre: grab(/genre\s*[:\-–]\s*(.+)/i),
        developer: grab(/developer\s*[:\-–]\s*(.+)/i) || "Unknown",
        publisher: grab(/publisher\s*[:\-–]\s*(.+)/i) || "Unknown",
        version: grab(/version\s*[:\-–]?\s*([\w.\d]+)/i) || "1.0",
        releaseDate: grab(/release\s*date\s*[:\-–]\s*(.+)/i),
        averageRating: (() => { const m = body.match(/([\d.]+)\s*\/\s*5/i); return m ? parseFloat(m[1]) : 0; })(),
        downloadCount: (() => { const m = body.match(/([\d,]+)\s*(?:downloads?|times)/i); return m ? parseInt(m[1].replace(/,/g, ""), 10) : 0; })(),
        tags: [...document.querySelectorAll('.tags a, a[href*="tag/"], [class*=tag] a')].map((e) => e.textContent.trim()).filter(Boolean),
        installationGuide: [...document.querySelectorAll("ol li")].map((li) => li.textContent.trim()),
        unzipPassword: grab(/(?:unzip\s+)?password\s*[:\-–]\s*(\S+)/i),
        bodyText: body,
        hasDownloadBtn,
      };
    });

    console.log(`  title: "${raw.title}"`);
    console.log(`  download button found: ${raw.hasDownloadBtn}`);

    // ── Get the download link ───────────────────────────────
    let dlUrl = null;
    if (raw.hasDownloadBtn) {
      dlUrl = await getDownloadLink(browser, page);
    } else {
      console.log("  ⚠️  no button.download_link on this page");
    }

    const requirements = parseRequirements(raw.bodyText);
    const now = new Date().toISOString();

    return {
      title: raw.title || "Untitled",
      slug: slugify(raw.title),
      description: raw.description,
      shortDescription: (raw.description || "").substring(0, 200),
      coverImage: raw.coverImage || "https://placehold.co/800x450/0f0f1a/7c3aed?text=No+Image",
      images: raw.images,
      genre: raw.genre || "PC Game",
      platforms: ["PC"],
      version: raw.version,
      developer: raw.developer,
      publisher: raw.publisher,
      releaseDate: raw.releaseDate || now,
      requirements,
      installationGuide: raw.installationGuide,
      downloadLinks: dlUrl
        ? [{ label: "Direct Download", url: dlUrl, size: raw.fileSize, host: hostFrom(dlUrl) }]
        : [],
      fileSize: raw.fileSize,
      isFeatured: false,
      averageRating: raw.averageRating,
      reviewCount: 0,
      downloadCount: raw.downloadCount,
      tags: raw.tags,
      changelog: "",
      _unzipPassword: raw.unzipPassword,
      createdAt: now,
      updatedAt: now,
    };
  } finally {
    await page.close();
  }
}

// ═════════════════════════════════════════════════════════════
//  STEP 3 — Click "Direct Download" → wait for redirect
//           to /en/downloads/ → wait for zulu.peskgames.net link
// ═════════════════════════════════════════════════════════════
async function getDownloadLink(browser, gamePage) {
  try {
    // ── Close any new tabs that open (ads) ──────────────────
    const closePopups = async (target) => {
      if (target.type() === "page") {
        const p = await target.page().catch(() => null);
        if (p && p !== gamePage) {
          console.log(`    🗑  closed popup: ${p.url().substring(0, 60)}`);
          await p.close().catch(() => {});
        }
      }
    };
    browser.on("targetcreated", closePopups);

    // ── Click button.download_link ──────────────────────────
    console.log("  🖱  clicking button.download_link …");

    // Wait for navigation that will happen when openLinkWithInf777o() runs
    const [navigation] = await Promise.all([
      gamePage.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => null),
      gamePage.click("button.download_link"),
    ]);

    const afterClickUrl = gamePage.url();
    console.log(`  → navigated to: ${afterClickUrl}`);

    // ── We should now be on /en/downloads/ ──────────────────
    // Wait for the countdown (~3 seconds + buffer)
    console.log("  ⏳ waiting 8s for countdown + link generation…");
    await sleep(8000);

    // ── Now look for the zulu.peskgames.net link ────────────
    // Strategy: poll the DOM every second for up to 30 seconds
    let downloadUrl = null;

    for (let attempt = 0; attempt < 20; attempt++) {
      downloadUrl = await gamePage.evaluate(() => {
        // 1) Check all <a> tags for peskgames.net links
        for (const a of document.querySelectorAll("a[href]")) {
          const href = a.href;
          // The download link is on a subdomain of peskgames.net (e.g. zulu.peskgames.net)
          if (/peskgames\.net/i.test(href)) return href;
          // Also check for JWT-style URLs (eyJ...)
          if (/\/eyJ[A-Za-z0-9_-]+\./i.test(href)) return href;
        }

        // 2) Check onclick attributes and data attributes
        for (const el of document.querySelectorAll("[onclick],[data-url],[data-href],[data-link]")) {
          const onclick = el.getAttribute("onclick") || "";
          const dataUrl = el.dataset.url || el.dataset.href || el.dataset.link || "";
          for (const str of [onclick, dataUrl]) {
            const m = str.match(/https?:\/\/[^\s"'`<>\\)]+peskgames\.net[^\s"'`<>\\)]*/i);
            if (m) return m[0];
            const jwt = str.match(/https?:\/\/[^\s"'`<>\\)]*\/eyJ[A-Za-z0-9_-]+\.[^\s"'`<>\\)]*/i);
            if (jwt) return jwt[0];
          }
        }

        // 3) Check window.location (maybe it sets location.href)
        if (/peskgames\.net/i.test(window.location.href)) return window.location.href;

        // 4) Search all inline scripts
        for (const script of document.querySelectorAll("script:not([src])")) {
          const text = script.textContent || "";
          const m = text.match(/https?:\/\/[^\s"'`<>\\)]*peskgames\.net[^\s"'`<>\\)]*/i);
          if (m) return m[0].replace(/["'`;].*$/, "");
          const jwt = text.match(/https?:\/\/[^\s"'`<>\\)]*\/eyJ[A-Za-z0-9_-]+\.[^\s"'`<>\\)]*/i);
          if (jwt) return jwt[0].replace(/["'`;].*$/, "");
        }

        // 5) Check meta refresh
        const meta = document.querySelector('meta[http-equiv="refresh"]');
        if (meta) {
          const content = meta.getAttribute("content") || "";
          const m = content.match(/url=(.+)/i);
          if (m && /peskgames\.net/i.test(m[1])) return m[1].trim();
        }

        return null;
      });

      if (downloadUrl) break;

      // Also check if the page itself redirected to the download URL
      const currentUrl = gamePage.url();
      if (/peskgames\.net/i.test(currentUrl) || /\/eyJ[A-Za-z0-9_-]+\./i.test(currentUrl)) {
        downloadUrl = currentUrl;
        break;
      }

      await sleep(1500);
    }

    browser.off("targetcreated", closePopups);

    if (downloadUrl) {
      // Clean up the URL
      downloadUrl = downloadUrl.replace(/["'`;>\s].*$/, "").trim();
      console.log(`  ✅ download link: ${downloadUrl.substring(0, 100)}…`);
    } else {
      // Last resort: dump what's on the page
      console.log("  ⚠️  download link not found after polling");
      const debugInfo = await gamePage.evaluate(() => ({
        url: window.location.href,
        links: [...document.querySelectorAll("a[href]")].slice(0, 20).map((a) => ({
          text: a.textContent.trim().substring(0, 50),
          href: a.href,
        })),
        bodySnippet: (document.body.innerText || "").substring(0, 500),
      }));
      console.log(`  current URL: ${debugInfo.url}`);
      console.log(`  links on page:`);
      debugInfo.links.forEach((l) => console.log(`    "${l.text}" → ${l.href}`));
      console.log(`  text: ${debugInfo.bodySnippet.replace(/\n/g, " | ").substring(0, 300)}`);
    }

    return downloadUrl;
  } catch (err) {
    console.error(`  ❌ download extraction error: ${err.message}`);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════
async function main() {
  console.log("🚀 Starting scraper…\n");

  const browser = await puppeteer.launch({
    headless: "new",
    defaultViewport: { width: 1366, height: 900 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-popup-blocking",
    ],
  });

  const results = [];

  try {
    const urls = await collectGameUrls(browser);

    for (let i = 0; i < urls.length; i++) {
      console.log(`\n${"═".repeat(60)}`);
      console.log(`[${i + 1}/${urls.length}] ${urls[i]}`);
      console.log("═".repeat(60));

      try {
        const game = await scrapeGame(browser, urls[i]);
        results.push(game);

        // Save after each game
        fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2), "utf-8");

        const icon = game.downloadLinks.length ? "✅" : "⚠️";
        console.log(`${icon} "${game.title}" → ${game.downloadLinks.length} download link(s)`);
        if (game.downloadLinks.length) {
          console.log(`   ${game.downloadLinks[0].url.substring(0, 100)}`);
        }
      } catch (err) {
        console.error(`❌ ${err.message}`);
      }

      if (i < urls.length - 1) await sleep(BETWEEN_GAMES);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n✨ Done — ${results.length} game(s) → ${OUTPUT}\n`);
}

main().catch(console.error);