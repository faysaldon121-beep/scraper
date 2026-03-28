// ankergames-scraper.js (fixed)
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const BASE_URL = "https://ankergames.net";
const OUTPUT = path.join(__dirname, "ankergames_data.json");
const PROGRESS_FILE = path.join(__dirname, "ankergames_progress.json");
const NAV_TIMEOUT = 60000;
const BETWEEN_GAMES = 3000;

/** Prefer env; falls back to project default if unset */
const MONGODB_URI =  "mongodb+srv://xTech:tmf717008@cluster0.ldm8qdf.mongodb.net/anker?appName=Cluster0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slugify(t) {
  return (t || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hostFrom(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Direct";
  }
}

/** Shape scraped game for Mongoose Game schema (images, dates, no extra keys). */
function gameForMongo(game) {
  const imgs = [];
  if (game.coverImage) imgs.push(game.coverImage);
  for (const s of game.screenshots || []) {
    if (s && !imgs.includes(s)) imgs.push(s);
  }
  let releaseDate = game.releaseDate;
  if (releaseDate && !(releaseDate instanceof Date)) {
    const d = new Date(releaseDate);
    releaseDate = isNaN(d.getTime()) ? new Date() : d;
  } else if (!releaseDate) {
    releaseDate = new Date();
  }
  return {
    title: game.title,
    slug: game.slug,
    description: game.description || " ",
    shortDescription: game.shortDescription || "",
    coverImage: game.coverImage || "",
    images: imgs,
    genre: game.genre || "PC Game",
    platforms: game.platforms?.length ? game.platforms : ["PC"],
    version: game.version || "1.0",
    developer: game.developer || "Unknown",
    publisher: game.publisher || "Unknown",
    releaseDate,
    requirements: game.requirements || {
      minimum: { os: "", cpu: "", ram: "", gpu: "", storage: "", directx: "" },
      recommended: { os: "", cpu: "", ram: "", gpu: "", storage: "", directx: "" },
    },
    installationGuide: game.installationGuide || [],
    downloadLinks: game.downloadLinks || [],
    fileSize: game.fileSize || "",
    isFeatured: !!game.isFeatured,
    averageRating: Math.min(5, Math.max(0, Number(game.averageRating) || 0)),
    reviewCount: Number(game.reviewCount) || 0,
    downloadCount: Number(game.downloadCount) || 0,
    tags: game.tags || [],
    changelog: game.changelog || "",
  };
}

// ─── Progress / resume ───────────────────────────────────────
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
      console.log(`📂 Resuming: ${data.completed.length} done, index ${data.lastIndex}`);
      return data;
    }
  } catch {}
  return { completed: [], lastIndex: 0, allUrls: [] };
}

async function saveProgress(progress, game = null) {
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), "utf-8");
    if (game) {
      const Game = require("./models/Game.js");
      const doc = gameForMongo(game);
      await Game.findOneAndUpdate({ slug: doc.slug }, doc, {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      });
      console.log(`   💾 Saved to MongoDB`);
    }
  } catch (err) {
    console.error(`❌ saveProgress failed: ${err.message}`);
  }
}

function loadResults() {
  try {
    if (fs.existsSync(OUTPUT)) return JSON.parse(fs.readFileSync(OUTPUT, "utf-8"));
  } catch {}
  return [];
}
function saveResults(r) {
  fs.writeFileSync(OUTPUT, JSON.stringify(r, null, 2), "utf-8");
}

// ─── Safe page creation (no setViewport — use defaultViewport) ─
async function stealthPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.chrome = { runtime: {} };
  });
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  return page;
}

// ─── Safe page close ─────────────────────────────────────────
async function safeClosed(page) {
  try {
    if (page && !page.isClosed()) await page.close();
  } catch {}
}

// ─── Safe evaluate (returns null if page died) ───────────────
async function safeEval(page, fn, ...args) {
  try {
    if (page.isClosed()) return null;
    return await page.evaluate(fn, ...args);
  } catch (err) {
    if (
      err.message.includes("Session closed") ||
      err.message.includes("Target closed") ||
      err.message.includes("detached") ||
      err.message.includes("Protocol error")
    ) {
      return null;
    }
    throw err;
  }
}

async function autoScroll(page) {
  if (page.isClosed()) return;
  await page
    .evaluate(() =>
      new Promise((resolve) => {
        let y = 0;
        const iv = setInterval(() => {
          window.scrollBy(0, 500);
          y += 500;
          if (y >= document.body.scrollHeight) {
            clearInterval(iv);
            resolve();
          }
        }, 150);
        setTimeout(() => {
          clearInterval(iv);
          resolve();
        }, 15000);
      })
    )
    .catch(() => {});
}

function parseRequirements(text) {
  const r = {
    minimum: { os: "", cpu: "", ram: "", gpu: "", storage: "", directx: "" },
    recommended: { os: "", cpu: "", ram: "", gpu: "", storage: "", directx: "" },
  };
  const extract = (chunk) => {
    const g = (rx) => {
      const m = chunk.match(rx);
      return m ? m[1].split("\n")[0].trim() : "";
    };
    return {
      os: g(/os\s*[:\-–]\s*(.+)/i),
      cpu: g(/(?:processor|cpu)\s*[:\-–]\s*(.+)/i),
      ram: g(/(?:memory|ram)\s*[:\-–]\s*(.+)/i),
      gpu: g(/(?:graphics|gpu|video)\s*[:\-–]\s*(.+)/i),
      storage: g(/(?:storage|disk|hdd|free\s*space)\s*[:\-–]\s*(.+)/i),
      directx: g(/directx\s*[:\-–]\s*(.+)/i),
    };
  };
  const mi = text.search(/minimum\s*(system\s*)?req/i);
  const ri = text.search(/recommended\s*(system\s*)?req/i);
  if (mi !== -1 && ri !== -1 && mi < ri) {
    r.minimum = extract(text.slice(mi, ri));
    r.recommended = extract(text.slice(ri, ri + 1500));
  } else if (mi !== -1) r.minimum = extract(text.slice(mi, mi + 1500));
  else if (ri !== -1) r.recommended = extract(text.slice(ri, ri + 1500));
  return r;
}

// ═════════════════════════════════════════════════════════════
//  STEP 1 — Collect game URLs
// ═════════════════════════════════════════════════════════════
async function collectGameUrls(browser) {
  console.log("📋 Collecting game URLs…\n");
  const page = await stealthPage(browser);
  const allUrls = new Set();

  try {
    let pageNum = 1;
    while (true) {
      const listUrl =
        pageNum === 1 ? `${BASE_URL}/top-games` : `${BASE_URL}/top-games?page=${pageNum}`;
      console.log(`   page ${pageNum}: ${listUrl}`);

      const res = await page
        .goto(listUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT })
        .catch(() => null);
      if (!res || res.status() >= 400) {
        console.log(`   → stopped (status ${res?.status()})`);
        break;
      }

      await autoScroll(page);
      await sleep(1000);

      const urls =
        (await safeEval(page, () => {
          const found = [];
          document.querySelectorAll("a[href]").forEach((a) => {
            const m = a.href.match(/\/game\/([^/?#]+)\/?$/);
            if (m && m[1].length > 1) found.push(a.href.replace(/\/+$/, ""));
          });
          return [...new Set(found)];
        })) || [];

      const before = allUrls.size;
      urls.forEach((u) => allUrls.add(u));
      console.log(`   → ${urls.length} links, ${allUrls.size - before} new (total: ${allUrls.size})`);

      if (allUrls.size - before === 0 && pageNum > 1) break;

      const hasNext = await safeEval(page, (num) => {
        return !!document.querySelector(`a[href*="page=${num + 1}"]`);
      }, pageNum);
      if (!hasNext) {
        console.log(`   → no next page`);
        break;
      }

      pageNum++;
      await sleep(1500);
    }

    const result = [...allUrls];
    console.log(`\n   ✅ Total: ${result.length} game URLs\n`);
    return result;
  } finally {
    await safeClosed(page);
  }
}

// ═════════════════════════════════════════════════════════════
//  STEP 2 — Scrape one game
// ═════════════════════════════════════════════════════════════
async function scrapeGame(browser, gameUrl) {
  const page = await stealthPage(browser);

  const popupHandler = async (target) => {
    try {
      if (target.type() !== "page") return;
      const p = await target.page().catch(() => null);
      if (!p || p === page) return;
      await sleep(500);
      if (!p.isClosed()) await p.close().catch(() => {});
    } catch {}
  };
  browser.on("targetcreated", popupHandler);

  try {
    await page.goto(gameUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });
    await autoScroll(page);
    await sleep(1500);

    const raw = await safeEval(page, () => {
      const body = document.body.innerText || "";
      const grab = (rx) => {
        const m = body.match(rx);
        return m ? m[1].split("\n")[0].trim() : "";
      };

      let title = "";
      const h1 = document.querySelector("h1");
      if (h1) title = h1.textContent.trim();
      if (!title) title = document.title.split(/[|\-–]/)[0].trim();

      let coverImage = "";
      const ogImg = document.querySelector('meta[property="og:image"]');
      if (ogImg) coverImage = ogImg.getAttribute("content") || "";
      if (!coverImage) {
        for (const img of document.querySelectorAll("img")) {
          const src = img.src || "";
          if (
            src &&
            (img.naturalWidth > 200 || img.width > 200) &&
            !src.includes("avatar") &&
            !src.includes("icon")
          ) {
            coverImage = src;
            break;
          }
        }
      }

      const screenshots = [];
      document.querySelectorAll("img").forEach((img) => {
        const src = img.src || "";
        if (src.includes("/uploads/screenshots/") && !screenshots.includes(src)) screenshots.push(src);
      });

      let description = "";
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) description = metaDesc.getAttribute("content") || "";
      for (const sel of [".game-description", ".description", "[class*=desc]", ".prose", "article", ".content"]) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim().length > description.length) description = el.innerText.trim();
      }

      const fsM = body.match(/([\d.,]+)\s*(GB|MB|TB)/i);
      let genre = grab(/genre\s*[:\-–]\s*(.+)/i);
      if (!genre) {
        genre = [...document.querySelectorAll('a[href*="genre"],a[href*="category"]')]
          .map((a) => a.textContent.trim())
          .filter(Boolean)
          .join(", ");
      }

      const tags = [];
      document
        .querySelectorAll('.tags a,a[href*="tag/"],[class*=tag] a,[class*=badge] a')
        .forEach((e) => {
          const t = e.textContent.trim();
          if (t && t.length < 30 && !tags.includes(t)) tags.push(t);
        });

      let trailerUrl = "";
      const iframe = document.querySelector('iframe[src*="youtube"],iframe[src*="youtu.be"]');
      if (iframe) trailerUrl = iframe.src;

      return {
        title,
        coverImage,
        screenshots,
        description,
        fileSize: fsM ? `${fsM[1]} ${fsM[2].toUpperCase()}` : "",
        genre,
        developer: grab(/developer\s*[:\-–]\s*(.+)/i) || "",
        publisher: grab(/publisher\s*[:\-–]\s*(.+)/i) || "",
        version: grab(/version\s*[:\-–]?\s*([\w.\d]+)/i) || "",
        releaseDate: grab(/release\s*date\s*[:\-–]\s*(.+)/i) || "",
        averageRating: (() => {
          const m = body.match(/([\d.]+)\s*\/\s*(?:5|10)/i);
          return m ? parseFloat(m[1]) : 0;
        })(),
        downloadCount: (() => {
          const m = body.match(/([\d,]+)\s*(?:downloads?|times)/i);
          return m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
        })(),
        tags,
        trailerUrl,
        installationGuide: [...document.querySelectorAll("ol li")].map((li) => li.textContent.trim()),
        unzipPassword: grab(/(?:unzip\s+)?password\s*[:\-–]\s*(\S+)/i),
        bodyText: body,
      };
    });

    if (!raw) throw new Error("Page closed during metadata extraction");

    console.log(`  title: "${raw.title}"`);
    console.log(`  screenshots: ${raw.screenshots.length}`);

    const dlUrl = await getDownloadLink(browser, page);

    const requirements = parseRequirements(raw.bodyText);
    const now = new Date().toISOString();

    return {
      title: raw.title || "Untitled",
      slug: slugify(raw.title),
      description: raw.description,
      shortDescription: (raw.description || "").substring(0, 200),
      coverImage: raw.coverImage || "",
      screenshots: raw.screenshots,
      genre: raw.genre || "PC Game",
      platforms: ["PC"],
      version: raw.version,
      developer: raw.developer,
      publisher: raw.publisher,
      releaseDate: raw.releaseDate,
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
      trailerUrl: raw.trailerUrl,
      _unzipPassword: raw.unzipPassword,
      createdAt: now,
      updatedAt: now,
    };
  } finally {
    browser.off("targetcreated", popupHandler);
    await safeClosed(page);
  }
}

// ═════════════════════════════════════════════════════════════
//  STEP 3 — Download flow
// ═════════════════════════════════════════════════════════════
async function getDownloadLink(browser, gamePage) {
  try {
    if (gamePage.isClosed()) return null;

    console.log("  🖱  opening download modal…");

    await safeEval(gamePage, () => {
      const btn =
        document.querySelector('button[\\@click*="open-download-modal"]') ||
        document.querySelector('button[x-on\\:click*="open-download-modal"]');
      if (btn) {
        btn.click();
        return;
      }

      window.dispatchEvent(new CustomEvent("open-download-modal"));

      const btns = [...document.querySelectorAll("button")];
      const dlBtn = btns.find((b) => {
        const t = (b.textContent || "").trim();
        return t === "Download" || (t.includes("Download") && t.length < 20);
      });
      if (dlBtn) dlBtn.click();
    });

    await sleep(2000);
    if (gamePage.isClosed()) return null;

    console.log("  🖱  clicking Direct Download…");

    const navPromise = gamePage
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 })
      .catch(() => null);

    await safeEval(gamePage, () => {
      let btn = document.querySelector("a.download-button");

      if (!btn) {
        const allAs = [...document.querySelectorAll("a")];
        btn = allAs.find((a) => {
          const onClick =
            a.getAttribute("@click.prevent") || a.getAttribute("x-on:click.prevent") || "";
          return onClick.includes("generateDownloadUrl");
        });
      }

      if (!btn) {
        const allAs = [...document.querySelectorAll("a")];
        btn = allAs.find((a) => {
          const t = (a.textContent || "").trim();
          return t === "Download" && a.classList.contains("download-button");
        });
      }

      if (btn) {
        btn.scrollIntoView({ behavior: "instant", block: "center" });
        btn.click();
        return "clicked";
      }

      const xDataEls = document.querySelectorAll("[x-data]");
      for (const el of xDataEls) {
        if (el._x_dataStack) {
          for (const data of el._x_dataStack) {
            if (typeof data.generateDownloadUrl === "function") {
              data.generateDownloadUrl(10);
              return "called_directly";
            }
          }
        }
        if (el.__x && el.__x.$data && typeof el.__x.$data.generateDownloadUrl === "function") {
          el.__x.$data.generateDownloadUrl(10);
          return "called_directly_v2";
        }
      }

      return "not_found";
    });

    await navPromise;

    if (gamePage.isClosed()) return null;

    const currentUrl = gamePage.url();
    console.log(`  → now on: ${currentUrl.substring(0, 80)}…`);

    if (!currentUrl.includes("/download/")) {
      console.log("  ⚠️  not on /download/ page, retrying…");
      await sleep(3000);
      if (gamePage.isClosed()) return null;
      const retryUrl = gamePage.url();
      if (!retryUrl.includes("/download/")) {
        console.log(`  ⚠️  still on ${retryUrl.substring(0, 60)}, giving up download`);
        return null;
      }
    }

    console.log("  ⏳ waiting for download link…");

    let downloadUrl = null;

    for (let attempt = 0; attempt < 30; attempt++) {
      if (gamePage.isClosed()) return null;

      downloadUrl = await safeEval(gamePage, () => {
        for (const a of document.querySelectorAll("a[href]")) {
          const h = a.href;
          if (/dlproxy|tunnel\d*\.dl/i.test(h)) return h;
        }

        if (/dlproxy|tunnel\d*\.dl/i.test(window.location.href)) return window.location.href;

        const xDataEls = document.querySelectorAll("[x-data]");
        for (const el of xDataEls) {
          if (el._x_dataStack) {
            for (const data of el._x_dataStack) {
              for (const [, val] of Object.entries(data)) {
                if (typeof val === "string" && /dlproxy|tunnel\d*\.dl/i.test(val)) return val;
              }
            }
          }
          if (el.__x && el.__x.$data) {
            for (const [, val] of Object.entries(el.__x.$data)) {
              if (typeof val === "string" && /dlproxy|tunnel\d*\.dl/i.test(val)) return val;
            }
          }
        }

        for (const script of document.querySelectorAll("script:not([src])")) {
          const t = script.textContent || "";
          const m = t.match(/https?:\/\/tunnel\d*\.dlproxy\.[^\s"'`<>\\)]+/i);
          if (m) return m[0].replace(/["'`;].*$/, "");
          const m2 = t.match(/https?:\/\/[^\s"'`<>\\)]*dlproxy\.[^\s"'`<>\\)]+/i);
          if (m2) return m2[0].replace(/["'`;].*$/, "");
        }

        for (const a of document.querySelectorAll("a[href]")) {
          const h = a.href;
          const t = (a.textContent || "").toLowerCase();
          if (
            t.includes("download") &&
            h &&
            !h.endsWith("#") &&
            !h.includes("ankergames.net") &&
            !h.includes("javascript") &&
            h.startsWith("http")
          ) {
            return h;
          }
        }

        for (const el of document.querySelectorAll("[data-url],[data-download-url],[data-href]")) {
          const u = el.dataset.url || el.dataset.downloadUrl || el.dataset.href || "";
          if (/dlproxy|tunnel/i.test(u)) return u;
        }

        for (const el of xDataEls) {
          let data = null;
          if (el._x_dataStack) data = Object.assign({}, ...el._x_dataStack);
          else if (el.__x?.$data) data = el.__x.$data;
          if (data) {
            if (data.downloadUrl) return data.downloadUrl;
            if (data.download_url) return data.download_url;
            if (data.directUrl) return data.directUrl;
            if (data.fileUrl) return data.fileUrl;
            if (data.url && typeof data.url === "string" && data.url.startsWith("http")) return data.url;
          }
        }

        return null;
      });

      if (downloadUrl) break;

      if (!gamePage.isClosed()) {
        const url = gamePage.url();
        if (/dlproxy|tunnel\d*\.dl/i.test(url)) {
          downloadUrl = url;
          break;
        }
      }

      await sleep(1000);
    }

    if (downloadUrl) {
      downloadUrl = downloadUrl.replace(/["'`;>\s].*$/, "").trim();
      console.log(`  ✅ ${downloadUrl.substring(0, 120)}…`);
    } else {
      console.log("  ⚠️  no download link found after 30s");
      if (!gamePage.isClosed()) {
        const debug = await safeEval(gamePage, () => ({
          url: window.location.href,
          links: [...document.querySelectorAll("a[href]")]
            .slice(0, 20)
            .map((a) => ({
              text: a.textContent.trim().substring(0, 40),
              href: a.href,
            })),
          bodySnippet: (document.body.innerText || "").substring(0, 400),
        }));
        if (debug) {
          console.log(`  page: ${debug.url}`);
          debug.links.forEach((l) => console.log(`    "${l.text}" → ${l.href.substring(0, 80)}`));
        }
      }
    }

    return downloadUrl;
  } catch (err) {
    if (
      err.message.includes("Session closed") ||
      err.message.includes("Protocol error") ||
      err.message.includes("Target closed") ||
      err.message.includes("detached")
    ) {
      console.log(`  ⚠️  page died during download: ${err.message.substring(0, 60)}`);
      return null;
    }
    console.error(`  ❌ download error: ${err.message}`);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════
//  MAIN — with full resume support + MongoDB
// ═════════════════════════════════════════════════════════════
async function main() {
  console.log("🚀 AnkerGames scraper\n");

  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connected to MongoDB\n");

  let browser = null;
  let progress = loadProgress();
  let results = loadResults();

  const launchBrowser = async () => {
    if (browser) try { await browser.close(); } catch {}
    browser = await puppeteer.launch({
      headless: "new",
      defaultViewport: { width: 1366, height: 900 },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-popup-blocking",
        "--disable-features=site-per-process",
      ],
    });
    return browser;
  };

  try {
    browser = await launchBrowser();

    let allUrls = progress.allUrls;
    if (!allUrls || allUrls.length === 0) {
      allUrls = await collectGameUrls(browser);
      progress.allUrls = allUrls;
      progress.lastIndex = 0;
      progress.completed = [];
      await saveProgress(progress);
    } else {
      console.log(`📂 Cached: ${allUrls.length} game URLs\n`);
    }

    const startIndex = progress.lastIndex || 0;
    let consecutiveErrors = 0;

    for (let i = startIndex; i < allUrls.length; i++) {
      const gameUrl = allUrls[i];

      if (progress.completed.includes(gameUrl)) {
        console.log(`[${i + 1}/${allUrls.length}] ⏭  skip: ${gameUrl}`);
        continue;
      }

      console.log(`\n${"═".repeat(60)}`);
      console.log(`[${i + 1}/${allUrls.length}] ${gameUrl}`);
      console.log("═".repeat(60));

      try {
        try {
          const pages = await browser.pages();
          if (!pages) throw new Error("browser dead");
        } catch {
          console.log("🔄 Browser dead, relaunching…");
          browser = await launchBrowser();
        }

        const game = await scrapeGame(browser, gameUrl);
        results.push(game);
        saveResults(results);

        progress.completed.push(gameUrl);
        progress.lastIndex = i + 1;
        await saveProgress(progress, game);

        const icon = game.downloadLinks.length ? "✅" : "⚠️";
        console.log(`${icon} "${game.title}" → ${game.downloadLinks.length} link(s)`);
        if (game.downloadLinks.length) console.log(`   ${game.downloadLinks[0].url.substring(0, 120)}`);

        consecutiveErrors = 0;
      } catch (err) {
        console.error(`❌ ${err.message}`);
        consecutiveErrors++;

        progress.lastIndex = i;
        await saveProgress(progress);

        const isBrowserDead =
          err.message.includes("Protocol error") ||
          err.message.includes("Session closed") ||
          err.message.includes("Target closed") ||
          err.message.includes("Connection closed") ||
          err.message.includes("net::ERR_") ||
          err.message.includes("detached") ||
          err.message.includes("crashed") ||
          err.message.includes("Navigation failed");

        if (isBrowserDead) {
          console.log("🔄 Restarting browser…");
          try {
            browser = await launchBrowser();
            console.log("✅ Browser restarted");
          } catch (e) {
            console.error(`❌ Restart failed: ${e.message}`);
            await sleep(10000);
            browser = await launchBrowser();
          }
          i--;
          await sleep(3000);
          continue;
        }

        if (consecutiveErrors >= 10) {
          console.error("⛔ 10 consecutive errors, exiting");
          break;
        }
        await sleep(3000);
      }

      if (i < allUrls.length - 1) await sleep(BETWEEN_GAMES);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }

  if (progress.completed.length >= progress.allUrls.length && progress.allUrls.length > 0) {
    try {
      fs.unlinkSync(PROGRESS_FILE);
    } catch {}
    console.log("🧹 Progress file removed (complete)");
  }

  console.log(`\n✨ Done — ${results.length} game(s) → ${OUTPUT}\n`);
}

main().catch(async (err) => {
  console.error(`💀 Fatal: ${err.message}`);
  console.error("Run again to resume.\n");
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
