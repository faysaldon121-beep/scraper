// // agent.js
// const puppeteer = require('puppeteer');
// const fs = require('fs');
// const path = require('path');

// const BASE_URL = 'https://128.199.174.22/tag/';
// const OUTPUT_FILE = path.join(__dirname, 'peskgames_data.json');
// const MAX_PAGES = 50; // Safety limit
// const TIMEOUT = 30000;

// class PeskGamesAgent {
//   constructor() {
//     this.browser = null;
//     this.page = null;
//     this.results = [];
//     this.visitedUrls = new Set();
//   }

//   // ─── Launch Browser ───────────────────────────────────────────
//   async init() {
//     console.log('🚀 Launching browser...');
//     this.browser = await puppeteer.launch({
//       headless: 'new',
//       args: [
//         '--no-sandbox',
//         '--disable-setuid-sandbox',
//         '--disable-dev-shm-usage',
//         '--disable-gpu',
//       ],
//       defaultViewport: { width: 1280, height: 900 },
//     });
//     this.page = await this.browser.newPage();

//     // Set a realistic user agent
//     await this.page.setUserAgent(
//       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
//       '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
//     );

//     // Block unnecessary resources for speed
//     await this.page.setRequestInterception(true);
//     this.page.on('request', (req) => {
//       const blocked = ['image', 'font', 'media'];
//       if (blocked.includes(req.resourceType())) {
//         req.abort();
//       } else {
//         req.continue();
//       }
//     });

//     this.page.setDefaultNavigationTimeout(TIMEOUT);
//     console.log('✅ Browser ready.\n');
//   }

//   // ─── Navigate with retry ─────────────────────────────────────
//   async goto(url, retries = 2) {
//     for (let i = 0; i <= retries; i++) {
//       try {
//         await this.page.goto(url, { waitUntil: 'networkidle2', timeout: TIMEOUT });
//         return true;
//       } catch (err) {
//         console.warn(`  ⚠️  Retry ${i + 1} for ${url}`);
//         if (i === retries) {
//           console.error(`  ❌ Failed to load: ${url}`);
//           return false;
//         }
//         await this.sleep(2000);
//       }
//     }
//   }

//   // ─── Step 1: Discover all game/software listing links ────────
//   async discoverListingLinks() {
//     console.log('📡 Visiting homepage to discover listings...');
//     const loaded = await this.goto(BASE_URL);
//     if (!loaded) return [];

//     // Gather links from the main page (articles, cards, post links)
//     let links = await this.page.evaluate((base) => {
//       const anchors = Array.from(document.querySelectorAll('a[href]'));
//       return anchors
//         .map((a) => a.href)
//         .filter((href) => {
//           // Keep internal links that look like individual post/game pages
//           return (
//             href.startsWith(base) &&
//             href !== base &&
//             href !== base + '/' &&
//             !href.includes('/page/') &&
//             !href.includes('#') &&
//             !href.includes('/category/') &&
//             !href.includes('/tag/') &&
//             !href.includes('/author/') &&
//             !href.includes('/wp-admin') &&
//             !href.includes('/feed') &&
//             !href.includes('/comment')
//           );
//         });
//     }, BASE_URL);

//     // Also check paginated listing pages
//     const paginatedLinks = await this.discoverPaginatedLinks();
//     links = [...links, ...paginatedLinks];

//     // De-duplicate
//     const unique = [...new Set(links)].slice(0, MAX_PAGES);
//     console.log(`🔗 Found ${unique.length} unique listing links.\n`);
//     return unique;
//   }

//   // ─── Step 1b: Crawl paginated archive pages ──────────────────
//   async discoverPaginatedLinks() {
//     const allLinks = [];
//     let pageNum = 2;
//     const maxArchivePages = 10;

//     while (pageNum <= maxArchivePages) {
//       const url = `${BASE_URL}/page/${pageNum}/`;
//       console.log(`  📄 Checking archive page ${pageNum}...`);
//       const loaded = await this.goto(url);
//       if (!loaded) break;

//       const links = await this.page.evaluate((base) => {
//         const anchors = Array.from(document.querySelectorAll('a[href]'));
//         return anchors
//           .map((a) => a.href)
//           .filter((href) => {
//             return (
//               href.startsWith(base) &&
//               href !== base &&
//               !href.includes('/page/') &&
//               !href.includes('#') &&
//               !href.includes('/category/') &&
//               !href.includes('/tag/')
//             );
//           });
//       }, BASE_URL);

//       if (links.length === 0) break;
//       allLinks.push(...links);
//       pageNum++;
//       await this.sleep(1000);
//     }

//     return allLinks;
//   }

//   // ─── Step 2: Scrape a single game/software page ──────────────
//   async scrapeDetailPage(url) {
//     if (this.visitedUrls.has(url)) return null;
//     this.visitedUrls.add(url);

//     console.log(`  🕹️  Scraping: ${url}`);
//     const loaded = await this.goto(url);
//     if (!loaded) return null;

//     const data = await this.page.evaluate(() => {
//       // --- Helper: get text or null ---
//       const getText = (sel) => {
//         const el = document.querySelector(sel);
//         return el ? el.innerText.trim() : null;
//       };

//       // --- Title ---
//       const title =
//         getText('h1.entry-title') ||
//         getText('h1.post-title') ||
//         getText('h1') ||
//         getText('title');

//       // --- Description / Content ---
//       const contentEl =
//         document.querySelector('.entry-content') ||
//         document.querySelector('.post-content') ||
//         document.querySelector('article');
//       const description = contentEl
//         ? contentEl.innerText.trim().substring(0, 1500)
//         : null;

//       // --- Thumbnail / Featured Image ---
//       const imgEl =
//         document.querySelector('.entry-content img') ||
//         document.querySelector('article img') ||
//         document.querySelector('.post-thumbnail img');
//       const thumbnail = imgEl ? imgEl.src : null;

//       // --- Categories / Tags ---
//       const categories = Array.from(
//         document.querySelectorAll('a[rel="category tag"], .cat-links a, .post-categories a')
//       ).map((a) => a.innerText.trim());

//       const tags = Array.from(
//         document.querySelectorAll('a[rel="tag"], .tag-links a, .post-tags a')
//       ).map((a) => a.innerText.trim());

//       // --- Published Date ---
//       const dateEl =
//         document.querySelector('time.entry-date') ||
//         document.querySelector('.posted-on time') ||
//         document.querySelector('time');
//       const publishedDate = dateEl
//         ? dateEl.getAttribute('datetime') || dateEl.innerText.trim()
//         : null;

//       // --- Download Links ---
//       // Broad approach: grab links whose text or href hints at a download
//       const allAnchors = Array.from(document.querySelectorAll('a[href]'));
//       const downloadLinks = allAnchors
//         .filter((a) => {
//           const href = a.href.toLowerCase();
//           const text = a.innerText.toLowerCase();
//           const classAttr = (a.className || '').toLowerCase();

//           const isDownload =
//             text.includes('download') ||
//             text.includes('get link') ||
//             text.includes('mirror') ||
//             text.includes('direct link') ||
//             text.includes('mega') ||
//             text.includes('mediafire') ||
//             text.includes('gdrive') ||
//             text.includes('google drive') ||
//             text.includes('torrent') ||
//             classAttr.includes('download') ||
//             href.includes('download') ||
//             href.includes('mega.nz') ||
//             href.includes('mediafire.com') ||
//             href.includes('drive.google.com') ||
//             href.includes('magnet:') ||
//             href.includes('.torrent') ||
//             href.includes('1fichier') ||
//             href.includes('uploadhaven') ||
//             href.includes('filecrypt') ||
//             href.includes('pixeldrain');

//           return isDownload;
//         })
//         .map((a) => ({
//           text: a.innerText.trim().substring(0, 200),
//           url: a.href,
//         }));

//       // --- Metadata table (some sites use a specs/info table) ---
//       const metaTable = {};
//       document
//         .querySelectorAll(
//           '.entry-content table tr, .game-info tr, .info-table tr'
//         )
//         .forEach((tr) => {
//           const cells = tr.querySelectorAll('td, th');
//           if (cells.length >= 2) {
//             const key = cells[0].innerText.trim();
//             const val = cells[1].innerText.trim();
//             if (key && val) metaTable[key] = val;
//           }
//         });

//       // --- System Requirements (look for common headers) ---
//       let systemRequirements = null;
//       const headings = Array.from(
//         document.querySelectorAll('h2, h3, h4, strong, b')
//       );
//       for (const h of headings) {
//         if (
//           h.innerText.toLowerCase().includes('system requirement') ||
//           h.innerText.toLowerCase().includes('minimum requirement')
//         ) {
//           let sibling = h.nextElementSibling;
//           const parts = [];
//           while (sibling && !['H2', 'H3', 'H4'].includes(sibling.tagName)) {
//             parts.push(sibling.innerText.trim());
//             sibling = sibling.nextElementSibling;
//           }
//           systemRequirements = parts.join('\n').substring(0, 1000) || null;
//           break;
//         }
//       }

//       return {
//         title,
//         description: description ? description.substring(0, 800) : null,
//         thumbnail,
//         categories,
//         tags,
//         publishedDate,
//         downloadLinks,
//         metaTable: Object.keys(metaTable).length > 0 ? metaTable : null,
//         systemRequirements,
//       };
//     });

//     if (!data || !data.title) return null;

//     return {
//       ...data,
//       sourceUrl: url,
//       scrapedAt: new Date().toISOString(),
//     };
//   }

//   // ─── Step 3: Follow intermediate download pages ───────────────
//   async resolveDownloadLinks(entry) {
//     if (!entry || !entry.downloadLinks) return entry;

//     const resolved = [];

//     for (const link of entry.downloadLinks) {
//       // If link goes to an internal interstitial page, follow it
//       if (link.url.startsWith(BASE_URL)) {
//         console.log(`    🔍 Following internal link: ${link.url}`);
//         try {
//           const loaded = await this.goto(link.url);
//           if (loaded) {
//             const innerLinks = await this.page.evaluate(() => {
//               return Array.from(document.querySelectorAll('a[href]'))
//                 .filter((a) => {
//                   const href = a.href.toLowerCase();
//                   return (
//                     href.includes('mega') ||
//                     href.includes('mediafire') ||
//                     href.includes('drive.google') ||
//                     href.includes('torrent') ||
//                     href.includes('1fichier') ||
//                     href.includes('uploadhaven') ||
//                     href.includes('pixeldrain') ||
//                     href.includes('download') ||
//                     href.includes('filecrypt')
//                   );
//                 })
//                 .map((a) => ({
//                   text: a.innerText.trim().substring(0, 200),
//                   url: a.href,
//                 }));
//             });

//             if (innerLinks.length > 0) {
//               resolved.push(...innerLinks);
//             } else {
//               resolved.push(link);
//             }
//           }
//         } catch {
//           resolved.push(link);
//         }
//       } else {
//         resolved.push(link);
//       }
//     }

//     // De-duplicate download links
//     const seen = new Set();
//     entry.downloadLinks = resolved.filter((l) => {
//       if (seen.has(l.url)) return false;
//       seen.add(l.url);
//       return true;
//     });

//     return entry;
//   }

//   // ─── Orchestrator ─────────────────────────────────────────────
//   async run() {
//     try {
//       await this.init();

//       // Step 1 — discover all listing pages
//       const listingLinks = await this.discoverListingLinks();

//       if (listingLinks.length === 0) {
//         console.log('⚠️  No listing links found. The site structure may have changed.');
//         await this.saveResults();
//         return;
//       }

//       // Step 2 — scrape each detail page
//       for (const link of listingLinks) {
//         try {
//           let entry = await this.scrapeDetailPage(link);
//           if (entry) {
//             // Step 3 — follow interstitial download pages
//             entry = await this.resolveDownloadLinks(entry);
//             this.results.push(entry);
//             console.log(
//               `    ✅ "${entry.title}" — ${entry.downloadLinks.length} download link(s)\n`
//             );
//           }
//         } catch (err) {
//           console.error(`    ❌ Error scraping ${link}: ${err.message}`);
//         }
//         // Be polite — throttle requests
//         await this.sleep(1500);
//       }

//       // Step 4 — save to JSON
//       await this.saveResults();
//     } catch (err) {
//       console.error('💥 Fatal error:', err);
//     } finally {
//       await this.shutdown();
//     }
//   }

//   // ─── Save JSON ────────────────────────────────────────────────
//   async saveResults() {
//     const output = {
//       source: BASE_URL,
//       scrapedAt: new Date().toISOString(),
//       totalEntries: this.results.length,
//       entries: this.results,
//     };

//     fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
//     console.log(`\n💾 Saved ${this.results.length} entries to ${OUTPUT_FILE}`);
//   }

//   // ─── Helpers ──────────────────────────────────────────────────
//   sleep(ms) {
//     return new Promise((resolve) => setTimeout(resolve, ms));
//   }

//   async shutdown() {
//     if (this.browser) {
//       await this.browser.close();
//       console.log('🛑 Browser closed.');
//     }
//   }
// }

// // ─── Run the agent ──────────────────────────────────────────────
// (async () => {
//   const agent = new PeskGamesAgent();
//   await agent.run();
// })();




// agent.js
const puppeteer = require('puppeteer');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Import the Video model (we'll define it next)
const Video = require('./models/Video');

const BASE_URL = 'http://178.128.25.172/';  // replace with actual adult site URL
const OUTPUT_FILE = path.join(__dirname, 'videos_data.json');
const MAX_PAGES = 50;
const TIMEOUT = 30000;

class AdultVideoScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.results = [];
    this.visitedUrls = new Set();
  }

  async init() {
    console.log('🚀 Launching browser...');
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
      defaultViewport: { width: 1280, height: 900 },
    });
    this.page = await this.browser.newPage();
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Block unnecessary resources for speed
    await this.page.setRequestInterception(true);
    this.page.on('request', (req) => {
      const blocked = ['image', 'font', 'media']; // we might want images for thumbnails
      if (blocked.includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    this.page.setDefaultNavigationTimeout(TIMEOUT);
    console.log('✅ Browser ready.\n');
  }

  async goto(url, retries = 2) {
    for (let i = 0; i <= retries; i++) {
      try {
        await this.page.goto(url, { waitUntil: 'networkidle2', timeout: TIMEOUT });
        // Handle age verification if present
        await this.handleAgeVerification();
        return true;
      } catch (err) {
        console.warn(`  ⚠️  Retry ${i + 1} for ${url}`);
        if (i === retries) {
          console.error(`  ❌ Failed to load: ${url}`);
          return false;
        }
        await this.sleep(2000);
      }
    }
  }

  async handleAgeVerification() {
    // Common adult site popups – try to click the "I am 18+" or similar button
    const ageSelectors = [
      'button[data-age-gate]',
      'button:contains("I am 18+")',
      'a:contains("Enter")',
      '#age-gate button',
      '.age-verification button',
    ];
    for (const selector of ageSelectors) {
      const button = await this.page.$(selector);
      if (button) {
        await button.click();
        console.log('  ✅ Age verification accepted.');
        await this.sleep(2000);
        break;
      }
    }
  }

  async discoverListingLinks() {
    console.log('📡 Visiting homepage to discover video listings...');
    const loaded = await this.goto(BASE_URL);
    if (!loaded) return [];

    let links = await this.page.evaluate((base) => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors
        .map((a) => a.href)
        .filter((href) => {
          // Adjust filters to match adult video page structure
          return (
            href.startsWith(base) &&
            href !== base &&
            href !== base + '/' &&
            !href.includes('/page/') &&
            !href.includes('#') &&
            !href.includes('/category/') &&
            !href.includes('/tag/') &&
            !href.includes('/author/') &&
            !href.includes('/wp-admin') &&
            !href.includes('/feed') &&
            !href.includes('/comment')
          );
        });
    }, BASE_URL);

    const paginatedLinks = await this.discoverPaginatedLinks();
    links = [...links, ...paginatedLinks];
    const unique = [...new Set(links)].slice(0, MAX_PAGES);
    console.log(`🔗 Found ${unique.length} unique video links.\n`);
    return unique;
  }

  async discoverPaginatedLinks() {
    const allLinks = [];
    let pageNum = 2;
    const maxArchivePages = 10;

    while (pageNum <= maxArchivePages) {
      const url = `${BASE_URL}/page/${pageNum}/`;
      console.log(`  📄 Checking archive page ${pageNum}...`);
      const loaded = await this.goto(url);
      if (!loaded) break;

      const links = await this.page.evaluate((base) => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        return anchors
          .map((a) => a.href)
          .filter((href) => {
            return (
              href.startsWith(base) &&
              href !== base &&
              !href.includes('/page/') &&
              !href.includes('#') &&
              !href.includes('/category/') &&
              !href.includes('/tag/')
            );
          });
      }, BASE_URL);

      if (links.length === 0) break;
      allLinks.push(...links);
      pageNum++;
      await this.sleep(1000);
    }

    return allLinks;
  }

  async scrapeDetailPage(url) {
    if (this.visitedUrls.has(url)) return null;
    this.visitedUrls.add(url);

    console.log(`  🎥 Scraping: ${url}`);
    const loaded = await this.goto(url);
    if (!loaded) return null;

    const data = await this.page.evaluate(() => {
      const getText = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerText.trim() : null;
      };

      // Title
      const title = getText('h1.entry-title') || getText('h1.post-title') || getText('h1') || getText('title');

      // Description / synopsis
      const contentEl = document.querySelector('.entry-content') || document.querySelector('.post-content') || document.querySelector('article');
      const description = contentEl ? contentEl.innerText.trim().substring(0, 1500) : null;

      // Thumbnail / preview image
      const imgEl = document.querySelector('.entry-content img') || document.querySelector('article img') || document.querySelector('.post-thumbnail img');
      const thumbnail = imgEl ? imgEl.src : null;

      // Categories / tags (could be niche, model, etc.)
      const categories = Array.from(
        document.querySelectorAll('a[rel="category tag"], .cat-links a, .post-categories a')
      ).map((a) => a.innerText.trim());

      const tags = Array.from(
        document.querySelectorAll('a[rel="tag"], .tag-links a, .post-tags a')
      ).map((a) => a.innerText.trim());

      // Published date
      const dateEl = document.querySelector('time.entry-date') || document.querySelector('.posted-on time') || document.querySelector('time');
      const publishedDate = dateEl ? dateEl.getAttribute('datetime') || dateEl.innerText.trim() : null;

      // Video download / embed links
      const allAnchors = Array.from(document.querySelectorAll('a[href]'));
      const downloadLinks = allAnchors
        .filter((a) => {
          const href = a.href.toLowerCase();
          const text = a.innerText.toLowerCase();
          const classAttr = (a.className || '').toLowerCase();

          const isDownload =
            text.includes('download') ||
            text.includes('get link') ||
            text.includes('mirror') ||
            text.includes('direct link') ||
            text.includes('watch') ||
            text.includes('play') ||
            text.includes('stream') ||
            classAttr.includes('download') ||
            href.includes('download') ||
            href.includes('mega.nz') ||
            href.includes('mediafire.com') ||
            href.includes('drive.google.com') ||
            href.includes('magnet:') ||
            href.includes('.mp4') ||
            href.includes('.mkv') ||
            href.includes('.avi');
          return isDownload;
        })
        .map((a) => ({
          text: a.innerText.trim().substring(0, 200),
          url: a.href,
        }));

      // Metadata table (duration, quality, actors, etc.)
      const metaTable = {};
      document.querySelectorAll('.entry-content table tr, .video-info tr, .info-table tr').forEach((tr) => {
        const cells = tr.querySelectorAll('td, th');
        if (cells.length >= 2) {
          const key = cells[0].innerText.trim();
          const val = cells[1].innerText.trim();
          if (key && val) metaTable[key] = val;
        }
      });

      // Additional video-specific fields (if structured data is present)
      let duration = null;
      let quality = null;
      let actors = [];

      // Look for duration in meta table or via selectors
      if (metaTable['Duration'] || metaTable['Runtime']) {
        duration = metaTable['Duration'] || metaTable['Runtime'];
      } else {
        const durEl = document.querySelector('.duration, .runtime, .video-length');
        if (durEl) duration = durEl.innerText.trim();
      }

      if (metaTable['Quality'] || metaTable['Resolution']) {
        quality = metaTable['Quality'] || metaTable['Resolution'];
      }

      if (metaTable['Actors'] || metaTable['Stars']) {
        actors = (metaTable['Actors'] || metaTable['Stars']).split(',').map(s => s.trim());
      }

      return {
        title,
        description: description ? description.substring(0, 800) : null,
        thumbnail,
        categories,
        tags,
        publishedDate,
        downloadLinks,
        metaTable: Object.keys(metaTable).length > 0 ? metaTable : null,
        duration,
        quality,
        actors,
      };
    });

    if (!data || !data.title) return null;

    return {
      ...data,
      sourceUrl: url,
      scrapedAt: new Date().toISOString(),
    };
  }

  async resolveDownloadLinks(entry) {
    if (!entry || !entry.downloadLinks) return entry;

    const resolved = [];
    for (const link of entry.downloadLinks) {
      if (link.url.startsWith(BASE_URL)) {
        console.log(`    🔍 Following internal link: ${link.url}`);
        try {
          const loaded = await this.goto(link.url);
          if (loaded) {
            const innerLinks = await this.page.evaluate(() => {
              return Array.from(document.querySelectorAll('a[href]'))
                .filter((a) => {
                  const href = a.href.toLowerCase();
                  return (
                    href.includes('mega') ||
                    href.includes('mediafire') ||
                    href.includes('drive.google') ||
                    href.includes('magnet:') ||
                    href.includes('.mp4') ||
                    href.includes('download')
                  );
                })
                .map((a) => ({
                  text: a.innerText.trim().substring(0, 200),
                  url: a.href,
                }));
            });
            if (innerLinks.length > 0) resolved.push(...innerLinks);
            else resolved.push(link);
          }
        } catch {
          resolved.push(link);
        }
      } else {
        resolved.push(link);
      }
    }

    const seen = new Set();
    entry.downloadLinks = resolved.filter((l) => {
      if (seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });
    return entry;
  }

  async saveToDatabase(entry) {
    try {
      const result = await Video.findOneAndUpdate(
        { sourceUrl: entry.sourceUrl },
        { $set: entry },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      console.log(`    💾 Saved/Updated "${entry.title}" to DB (id: ${result._id})`);
    } catch (err) {
      console.error(`    ❌ Failed to save ${entry.title}: ${err.message}`);
    }
  }

  async run() {
    try {
      await this.init();

      const listingLinks = await this.discoverListingLinks();
      if (listingLinks.length === 0) {
        console.log('⚠️  No video links found.');
        return;
      }

      for (const link of listingLinks) {
        try {
          let entry = await this.scrapeDetailPage(link);
          if (entry) {
            entry = await this.resolveDownloadLinks(entry);
            await this.saveToDatabase(entry);
            this.results.push(entry);
            console.log(`    ✅ "${entry.title}" — ${entry.downloadLinks.length} download link(s)\n`);
          }
        } catch (err) {
          console.error(`    ❌ Error scraping ${link}: ${err.message}`);
        }
        await this.sleep(1500);
      }

      console.log(`\n🎉 Scraping complete. ${this.results.length} videos saved to DB.`);
    } catch (err) {
      console.error('💥 Fatal error:', err);
    } finally {
      await this.shutdown();
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async shutdown() {
    if (this.browser) {
      await this.browser.close();
      console.log('🛑 Browser closed.');
    }
    await mongoose.connection.close();
    console.log('🔌 MongoDB connection closed.');
  }
}

// Connect to MongoDB and start
(async () => {
  try {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI not defined. Set it in environment variables.');
    }

    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB Atlas');

    const scraper = new AdultVideoScraper();
    await scraper.run();
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  }
})();
