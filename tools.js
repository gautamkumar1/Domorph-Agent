import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import pLimit from "p-limit";
import express from "express";

puppeteer.use(StealthPlugin());

// Track the website server
let websiteServer = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONCURRENCY_LIMIT = 5;
const limit = pLimit(CONCURRENCY_LIMIT);
async function getFolderStructure(dir, base = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  const structure = [];

  for (const entry of entries) {
    if (entry.name === "assets") continue; // ⛔ Skip assets folder

    const relativePath = path.join(base, entry.name);
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const children = await getFolderStructure(fullPath, relativePath);
      structure.push({ type: "folder", name: entry.name, children });
    } else {
      structure.push({ type: "file", name: entry.name });
    }
  }

  return structure;
}


const autoScroll = async (page) => {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
};

const normalizeUrl = (rawUrl) => {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
};

const urlToPath = (baseDir, url) => {
  const parsed = new URL(url);
  let pathname = parsed.pathname.replace(/\/$/, "");
  if (pathname === "") pathname = "/index";
  return path.join(baseDir, `${pathname}.html`);
};

const extractInternalLinks = async (page, baseUrl) => {
  const origin = new URL(baseUrl).origin;
  const links = await page.$$eval("a[href]", (anchors) =>
    anchors.map((a) => a.href)
  );
  const uniqueLinks = Array.from(
    new Set(
      links
        .map((link) => {
          try {
            const u = new URL(link, origin);
            return u.origin === origin ? u.href : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .map(normalizeUrl)
        .filter(Boolean)
    )
  );
  return uniqueLinks;
};

async function scrapePage(browser, url, baseDir, visited, queue) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl || visited.has(normalizedUrl)) return;
  visited.add(normalizedUrl);

  const page = await browser.newPage();
  try {
    await page.goto(normalizedUrl, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await autoScroll(page);

    const assetDir = path.join(baseDir, "assets");
    const jsDir = path.join(assetDir, "js");
    await fs.mkdir(jsDir, { recursive: true });

    // Handle images
    const imageHandles = await page.$$eval("img", (imgs) => {
      const base = location.origin;
      function getBestSrc(srcset) {
        if (!srcset) return null;
        const candidates = srcset.split(",").map((s) => s.trim().split(" ")[0]);
        return candidates[candidates.length - 1] || null;
      }
      return imgs
        .map((img) => {
          const srcset = img.getAttribute("srcset");
          let src = getBestSrc(srcset);
          if (!src) src = img.getAttribute("src") || "";
          try {
            return new URL(src, base).href;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    });

    const localImagePaths = [];

    for (let i = 0; i < imageHandles.length; i++) {
      const imageUrl = imageHandles[i];
      try {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Failed to fetch image: ${imageUrl}`);
        const contentType = response.headers.get("content-type");
        let extension = "jpg";
        if (contentType?.includes("png")) extension = "png";
        else if (contentType?.includes("jpeg") || contentType?.includes("jpg"))
          extension = "jpg";
        const imageName = `image_${Date.now()}_${i}.${extension}`;
        const imagePath = path.join(assetDir, imageName);
        const buffer = await response.buffer();
        await fs.writeFile(imagePath, buffer);
        const localPath = `/scraped_website/assets/${imageName}`;
        localImagePaths.push(localPath);
      } catch (err) {
        console.warn(`Image download failed: ${imageUrl}, ${err.message}`);
        localImagePaths.push(imageUrl); // fallback
      }
    }

    await page.evaluate((newSources) => {
      const imgs = Array.from(document.querySelectorAll("img"));
      imgs.forEach((img, i) => {
        if (newSources[i]) {
          img.setAttribute("src", newSources[i]);
        }
        img.removeAttribute("srcset");
      });
    }, localImagePaths);

    // Download and rewrite JS files
    const scriptSrcs = await page.$$eval("script[src]", (scripts) =>
      scripts.map((s) => s.src)
    );

    const localScriptPaths = [];

    for (const srcUrl of scriptSrcs) {
      try {
        const urlObj = new URL(srcUrl, page.url());
        const filename = path.basename(urlObj.pathname);
        const jsPath = path.join(jsDir, filename);
        const localUrl = `/scraped_website/assets/js/${filename}`;
        const res = await fetch(urlObj.href);
        if (!res.ok) throw new Error(`JS fetch failed: ${urlObj.href}`);
        const buffer = await res.buffer();
        await fs.writeFile(jsPath, buffer);
        localScriptPaths.push({ original: srcUrl, local: localUrl });
      } catch (err) {
        console.warn(`JS download failed: ${srcUrl}, ${err.message}`);
      }
    }

    await page.$$eval(
      "script[src]",
      (scripts, replacements) => {
        scripts.forEach((s) => {
          const found = replacements.find((r) => s.src.includes(r.original));
          if (found) {
            s.src = found.local;
          }
        });
      },
      localScriptPaths
    );

    // Extract and enqueue new internal links
    const internalLinks = await extractInternalLinks(page, normalizedUrl);
    for (const link of internalLinks) {
      if (!visited.has(link) && !queue.includes(link)) {
        queue.push(link);
      }
    }

    // Rewrite anchor hrefs to local paths
    await page.$$eval(
      "a[href]",
      (anchors, baseOrigin) => {
        anchors.forEach((a) => {
          try {
            const url = new URL(a.href, baseOrigin);
            if (url.origin === baseOrigin) {
              let path = url.pathname.replace(/\/$/, "") || "/index";
              const hash = url.hash || "";
              a.setAttribute("href", `/scraped_website${path}.html${hash}`);
            }
          } catch {}
        });
      },
      new URL(url).origin
    );

    // Comment out remaining script tags
    await page.$$eval("script", (scripts) => {
      scripts.forEach((script) => {
        const content = script.outerHTML;
        const comment = document.createComment(content);
        script.replaceWith(comment);
      });
    });

    // Inline styles
    const stylesheets = await page.$$eval("link[rel='stylesheet']", (links) =>
      links.map((link) => link.href)
    );

    let cssContent = "";
    for (const href of stylesheets) {
      try {
        const css = await (await fetch(href)).text();
        cssContent += `\n/* ${href} */\n${css}`;
      } catch {}
    }

    let content = await page.content();

    if (cssContent) {
      content = content.replace(
        "</head>",
        `<style>${cssContent}</style></head>`
      );
    }

    content = content.replace(
      "</head>",
      `<base href="/scraped_website/">\n</head>`
    );

    const filePath = urlToPath(baseDir, normalizedUrl);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    console.log(`✅ Saved: ${normalizedUrl} → ${filePath}`);
  } catch (err) {
    console.warn(`❌ Failed ${normalizedUrl}: ${err.message}`);
  } finally {
    await page.close();
  }
}

export const webScraping = async (url) => {
  if (!url || typeof url !== "string") {
    return { message: "Invalid or missing URL." };
  }

  // Close existing server if one is running
  if (websiteServer) {
    await new Promise(resolve => websiteServer.close(resolve));
    websiteServer = null;
  }

  const baseDir = path.join(process.cwd(), "scraped_website");
  await fs.mkdir(baseDir, { recursive: true });

  const visited = new Set();
  const queue = [normalizeUrl(url)];

  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new" });

    while (queue.length > 0) {
      const batch = queue.splice(0, CONCURRENCY_LIMIT);
      await Promise.all(
        batch.map((link) =>
          limit(() => scrapePage(browser, link, baseDir, visited, queue))
        )
      );
    }
    
    // Start an Express server to serve the scraped website
    const app = express();
    app.use('/scraped_website', express.static(baseDir));
    
    // Create an index route that redirects to the scraped website
    app.get('/', (req, res) => {
      res.redirect('/scraped_website/index.html');
    });
    
    // Start the server on port 3030
    const port = 3030;
    websiteServer = app.listen(port, () => {
      console.log(`Scraped website running at http://localhost:${port}/scraped_website/`);
    });
    
    // Make the server close when the process exits
    process.on('exit', () => {
      if (websiteServer) {
        websiteServer.close();
      }
    });
    
    // Also handle SIGINT (Ctrl+C) and SIGTERM
    process.on('SIGINT', () => {
      if (websiteServer) {
        websiteServer.close();
      }
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      if (websiteServer) {
        websiteServer.close();
      }
      process.exit(0);
    });

    const folderStructure = await getFolderStructure(baseDir);
    return {
      message: `Scraped ${visited.size} pages successfully. Website running at http://localhost:3030/scraped_website/`,
      structure: folderStructure,
      serverUrl: `http://localhost:3030/scraped_website/`
    };
  } catch (err) {
    console.error("Scraping failed:", err);
    return { message: "Scraping failed" };
  } finally {
    if (browser) await browser.close();
  }
};

export const updateHtml = async (file, oldText, newText) => {
  console.log(`🔄 HTML Update Tool - Updating ${file}: replacing "${oldText}" with "${newText}"`);
  
  if (!file || !oldText || !newText) {
    console.error("❌ Missing required parameters for HTML update");
    return { 
      success: false, 
      message: "Missing required parameters. File, oldText, and newText are all required." 
    };
  }
  
  try {
    // Construct the file path within the scraped_website directory
    const baseDir = path.join(process.cwd(), "scraped_website");
    const filePath = path.join(baseDir, file);
    
    console.log(`📂 Looking for file: ${filePath}`);
    
    // Check if the file exists
    try {
      await fs.access(filePath);
      console.log(`✅ File exists: ${filePath}`);
    } catch (error) {
      console.error(`❌ File not found: ${filePath}`);
      return { 
        success: false, 
        message: `File not found: ${file}` 
      };
    }
    
    // Read the file content
    const content = await fs.readFile(filePath, 'utf-8');
    console.log(`📄 Read file content (${content.length} chars)`);
    
    // Check if the text to replace exists in the file
    if (!content.includes(oldText)) {
      console.warn(`⚠️ Text "${oldText}" not found in ${file}`);
      
      // Additional debugging: Show sample of file content
      const preview = content.substring(0, 200) + "...";
      console.log(`📝 File content preview: ${preview}`);
      
      return { 
        success: false, 
        message: `Text "${oldText}" not found in ${file}` 
      };
    }
    
    console.log(`✅ Found text "${oldText}" in the file`);
    
    // Replace the text
    const updatedContent = content.replace(new RegExp(oldText, 'g'), newText);
    
    // Write the updated content back to the file
    await fs.writeFile(filePath, updatedContent, 'utf-8');
    console.log(`✅ Successfully updated ${file}`);
    
    // Restart the server if it's running
    if (websiteServer) {
      console.log("🔄 Restarting scraped website server...");
      await new Promise(resolve => websiteServer.close(resolve));
      
      // Start the server on port 3030
      const app = express();
      app.use('/scraped_website', express.static(baseDir));
      
      // Create an index route that redirects to the scraped website
      app.get('/', (req, res) => {
        res.redirect('/scraped_website/index.html');
      });
      
      const port = 3030;
      websiteServer = app.listen(port, () => {
        console.log(`✅ Scraped website restarted at http://localhost:${port}/scraped_website/`);
      });
    } else {
      console.log("⚠️ Website server not running, no restart needed");
    }
    
    return { 
      success: true, 
      message: `Successfully updated "${oldText}" to "${newText}" in ${file}`,
      serverUrl: `http://localhost:3030/scraped_website/` 
    };
    
  } catch (error) {
    console.error("❌ Error updating HTML:", error);
    return { 
      success: false, 
      message: `Error updating HTML: ${error.message}` 
    };
  }
};
