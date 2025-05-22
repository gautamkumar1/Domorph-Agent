import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import pLimit from "p-limit";
import express from "express";
import * as cheerio from 'cheerio';
import { diff_match_patch } from 'diff-match-patch';

puppeteer.use(StealthPlugin());

// Track the website server
let websiteServer = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONCURRENCY_LIMIT = 5;
const limit = pLimit(CONCURRENCY_LIMIT);

// Initialize diff-match-patch
const dmp = new diff_match_patch();

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
    console.log(content," ===================content");
    
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

// Helper function to find relevant HTML snippet based on user instruction
async function findHtmlSnippet(html, instruction) {
  console.log(`🔍 Finding relevant HTML snippet for: "${instruction}"`);
  
  // Extract key terms from the instruction
  const terms = instruction.toLowerCase().split(/\s+/).filter(term => 
    !['the', 'a', 'an', 'make', 'change', 'set', 'to', 'of', 'in', 'on', 'with'].includes(term)
  );
  
  console.log(`📊 Key terms extracted: ${terms.join(', ')}`);
  
  // Get Anthropic API key from environment
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error("❌ Missing ANTHROPIC_API_KEY environment variable");
    throw new Error("Missing API key configuration");
  }
  
  // Create a prompt to find the snippet
  const prompt = `
You are an expert HTML analyst. Your task is to find the most relevant HTML snippet from a larger document based on a user instruction.

USER INSTRUCTION: "${instruction}"

For example, if the instruction is "make the Contact button color red", you need to find the HTML code for the Contact button.

FULL HTML:
\`\`\`html
${html}
\`\`\`

Return ONLY a JSON object with the following format:
{
  "snippet": "the exact HTML code snippet that needs to be modified, including the full element and its children",
  "lineStart": approximate line number where this snippet starts in the original HTML,
  "lineEnd": approximate line number where this snippet ends in the original HTML,
  "elementType": "the type of HTML element (e.g. 'button', 'div', etc.)",
  "elementIdentifier": "text or attribute that uniquely identifies this element",
  "modificationNeeded": "brief description of what needs to be changed"
}

Do not include any explanation, just the JSON object.`;

  try {
    // Send request to find the relevant snippet
    console.log(`🤖 Sending request to Anthropic API to find relevant snippet...`);
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1000,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Anthropic API error: ${response.status}`, errorText);
      throw new Error(`Error from Anthropic API: ${response.status}`);
    }
    
    const result = await response.json();
    const snippetResponse = result.content[0].text.trim();
    
    // Parse the JSON response
    let snippetInfo;
    try {
      // Extract JSON if it's wrapped in markdown code blocks
      const jsonMatch = snippetResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || 
                       snippetResponse.match(/({[\s\S]*})/);
      
      const jsonString = jsonMatch ? jsonMatch[1] : snippetResponse;
      snippetInfo = JSON.parse(jsonString);
      
      console.log(`✅ Found relevant snippet: ${snippetInfo.elementType} (${snippetInfo.elementIdentifier})`);
      console.log(`   Approx. lines ${snippetInfo.lineStart}-${snippetInfo.lineEnd}`);
      return snippetInfo;
    } catch (error) {
      console.error(`❌ Failed to parse JSON response for snippet:`, error);
      console.log("Raw response:", snippetResponse);
      throw new Error(`Failed to parse snippet info: ${error.message}`);
    }
  } catch (error) {
    console.error(`❌ Error finding HTML snippet:`, error);
    throw error;
  }
}

// Helper function to update a specific HTML snippet
async function updateHtmlSnippet(snippet, instruction) {
  console.log(`🔄 Updating HTML snippet based on instruction: "${instruction}"`);
  
  // Get Anthropic API key from environment
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error("❌ Missing ANTHROPIC_API_KEY environment variable");
    throw new Error("Missing API key configuration");
  }
  
  // Create a prompt for the LLM to update just the snippet
  const prompt = `
You are an expert web developer tasked with modifying a specific HTML element based on user instructions.

ELEMENT TO MODIFY:
\`\`\`html
${snippet}
\`\`\`

USER INSTRUCTION: "${instruction}"

Your task:
1. Apply ONLY the requested changes to this HTML snippet
2. Maintain all existing attributes and structure except for what needs to be changed
3. Return ONLY the modified HTML snippet with no explanation

Modified snippet:`;

  try {
    // Send request to update the snippet
    console.log(`🤖 Sending request to Anthropic API to update snippet...`);
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1000,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Anthropic API error: ${response.status}`, errorText);
      throw new Error(`Error from Anthropic API: ${response.status}`);
    }
    
    const result = await response.json();
    const updatedSnippet = result.content[0].text.trim();
    
    // Remove any markdown code block formatting if present
    const cleanSnippet = updatedSnippet.replace(/```(?:html)?\s*([\s\S]*?)\s*```/g, '$1').trim();
    
    console.log(`✅ Successfully updated snippet`);
    return cleanSnippet;
  } catch (error) {
    console.error(`❌ Error updating HTML snippet:`, error);
    throw error;
  }
}

// Enhanced intelligentHtmlUpdate function using Cheerio
export const intelligentHtmlUpdate = async (file, instruction) => {
  console.log(`🧠 Intelligent HTML Update - File: ${file}, Instruction: "${instruction}"`);
  
  if (!file || !instruction) {
    return { 
      success: false, 
      message: "Missing required parameters. File and instruction are required." 
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
    
    // Parse instruction to extract target element information
    const { targetElement, targetAction } = parseInstruction(instruction);
    console.log(`🔍 Parsed instruction: ${JSON.stringify({ targetElement, targetAction })}`);
    
    // Load HTML with Cheerio
    const $ = cheerio.load(content);
    
    // Find the target element
    let targetSelector;
    let $targetElement;
    
    // Try to find button/element by exact text match
    if (targetElement.type === 'button') {
      $targetElement = $(`button:contains("${targetElement.text}")`).filter(function() {
        return $(this).text().trim() === targetElement.text.trim();
      });
      
      // If exact match failed, try partial match
      if ($targetElement.length === 0) {
        $targetElement = $(`button:contains("${targetElement.text}")`);
      }
      
      // Try other elements that might be styled as buttons
      if ($targetElement.length === 0) {
        $targetElement = $(`a:contains("${targetElement.text}")`)
          .add(`div:contains("${targetElement.text}")`)
          .add(`span:contains("${targetElement.text}")`)
          .filter(function() {
            // Check if this element likely represents a button
            const classes = $(this).attr('class') || '';
            const hasButtonClass = classes.toLowerCase().includes('button') || 
                                  classes.toLowerCase().includes('btn');
            const hasButtonStyles = $(this).css('cursor') === 'pointer' || 
                                   $(this).css('padding') !== undefined;
            const isClickable = $(this).attr('onclick') !== undefined || 
                               $(this).attr('href') !== undefined;
            
            // Check if the text closely matches
            const elementText = $(this).text().trim();
            const targetText = targetElement.text.trim();
            const textMatches = elementText.includes(targetText) || 
                               targetText.includes(elementText);
            
            return textMatches && (hasButtonClass || hasButtonStyles || isClickable);
          });
      }
    } else {
      // Generic element search based on text content
      $targetElement = $(`*:contains("${targetElement.text}")`).filter(function() {
        const elementText = $(this).text().trim();
        return elementText === targetElement.text.trim() && 
               !$(this).children().text().includes(targetElement.text);
      });
    }
    
    // If no elements found, fall back to LLM-based approach
    if ($targetElement.length === 0) {
      console.log(`⚠️ No exact element match found, falling back to LLM-based approach`);
      
      try {
        // Use the existing LLM-based approach
        const snippetInfo = await findHtmlSnippet(content, instruction);
        const updatedSnippet = await updateHtmlSnippet(snippetInfo.snippet, instruction);
        
        // Create a regex to find the exact snippet
        const escapedSnippet = snippetInfo.snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const snippetRegex = new RegExp(escapedSnippet, 'g');
        
        // Replace the snippet in the original HTML
        const modifiedContent = content.replace(snippetRegex, updatedSnippet);
        
        // Check if any change was made
        if (modifiedContent === content) {
          console.warn("⚠️ Regex replacement didn't work, falling back to approximate line replacement");
          
          // Fallback approach: use the approximate line numbers
          const lines = content.split('\n');
          const lineStart = Math.max(0, snippetInfo.lineStart - 1); // 0-indexed
          const lineEnd = Math.min(lines.length, snippetInfo.lineEnd);
          
          // Replace the relevant lines
          const beforeLines = lines.slice(0, lineStart);
          const afterLines = lines.slice(lineEnd);
          
          // Construct the new content
          const newContent = [...beforeLines, updatedSnippet, ...afterLines].join('\n');
          
          // Write the modified content back to the file
          await fs.writeFile(filePath, newContent, 'utf-8');
        } else {
          // Write the modified content back to the file
          await fs.writeFile(filePath, modifiedContent, 'utf-8');
        }
        
        // Restart the server
        await restartServer(baseDir);
        
        return { 
          success: true, 
          message: `Successfully updated ${file} based on instruction: "${instruction}"`,
          serverUrl: `http://localhost:3030/scraped_website/`,
          update: {
            elementType: snippetInfo.elementType,
            identifier: snippetInfo.elementIdentifier,
            change: snippetInfo.modificationNeeded
          }
        };
      } catch (error) {
        console.error(`❌ Error with fallback approach:`, error);
        return { 
          success: false, 
          message: `Failed to find matching element for: "${instruction}"` 
        };
      }
    }
    
    console.log(`✅ Found matching element: ${$targetElement.length > 0}`);
    
    // Store original HTML for diffing
    const originalHtml = $.html();
    const originalElementHtml = $.html($targetElement);
    console.log(`Original element HTML: ${originalElementHtml.substring(0, 100)}...`);
    
    // Apply the requested changes
    if (targetAction.type === 'color' || targetAction.type === 'colour') {
      if (targetAction.property === 'background' || targetAction.property === 'bg') {
        $targetElement.css('background-color', targetAction.value);
      } else {
        $targetElement.css('color', targetAction.value);
      }
    } else if (targetAction.type === 'style') {
      $targetElement.css(targetAction.property, targetAction.value);
    } else if (targetAction.type === 'text') {
      $targetElement.text(targetAction.value);
    } else if (targetAction.type === 'class') {
      if (targetAction.operation === 'add') {
        $targetElement.addClass(targetAction.value);
      } else if (targetAction.operation === 'remove') {
        $targetElement.removeClass(targetAction.value);
      }
    } else if (targetAction.type === 'attribute') {
      $targetElement.attr(targetAction.property, targetAction.value);
    }
    
    // Get the modified HTML
    const modifiedElementHtml = $.html($targetElement);
    console.log(`Modified element HTML: ${modifiedElementHtml.substring(0, 100)}...`);
    
    // Generate the updated HTML
    const updatedHtml = $.html();
    
    // Create a diff to verify changes were made
    const diff = dmp.diff_main(originalHtml, updatedHtml);
    if (diff.length <= 1) {
      console.warn("⚠️ No changes detected in HTML after modification");
      
      // Fall back to direct element replacement if no diff detected
      const updatedContent = content.replace(
        originalElementHtml,
        modifiedElementHtml
      );
      
      // Write the updated content back to the file
      await fs.writeFile(filePath, updatedContent, 'utf-8');
    } else {
      // Write the modified content back to the file
      await fs.writeFile(filePath, updatedHtml, 'utf-8');
    }
    
    // Restart the server
    await restartServer(baseDir);
    
    return { 
      success: true, 
      message: `Successfully updated ${targetElement.type || 'element'} with text "${targetElement.text}" in ${file}`,
      serverUrl: `http://localhost:3030/scraped_website/`,
      update: {
        elementType: targetElement.type || 'element',
        identifier: targetElement.text,
        change: `${targetAction.type}: ${targetAction.value}`
      }
    };
    
  } catch (error) {
    console.error("❌ Error in intelligent HTML update:", error);
    return { 
      success: false, 
      message: `Error updating HTML: ${error.message}` 
    };
  }
};

// Helper function to restart the server
async function restartServer(baseDir) {
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
}

// Helper function to parse the instruction into target element and action
function parseInstruction(instruction) {
  console.log(`Parsing instruction: "${instruction}"`);
  
  // Default values
  const result = {
    targetElement: {
      type: 'button',
      text: ''
    },
    targetAction: {
      type: 'color',
      value: '',
      property: 'color'
    }
  };
  
  // Extract button/element text
  const changedMatch = instruction.match(/changed\s+the\s+(.*?)\s+button\s+(?:colour|color)\s+to\s+(\w+)/i);
  const makeMatch = instruction.match(/make\s+the\s+(.*?)\s+button\s+(?:colour|color)\s+(\w+)/i);
  
  if (changedMatch) {
    result.targetElement.text = changedMatch[1].trim();
    result.targetAction.value = changedMatch[2].trim();
    result.targetAction.type = 'color';
  } else if (makeMatch) {
    result.targetElement.text = makeMatch[1].trim();
    result.targetAction.value = makeMatch[2].trim();
    result.targetAction.type = 'color';
  } else {
    // More complex parsing for other types of instructions
    // Background color change
    const bgColorMatch = instruction.match(/(?:change|set|make)\s+(?:the\s+)?(.*?)\s+(?:background|bg)\s+(?:colour|color)\s+(?:to\s+)?(\w+)/i);
    if (bgColorMatch) {
      result.targetElement.text = bgColorMatch[1].trim();
      result.targetAction.value = bgColorMatch[2].trim();
      result.targetAction.type = 'color';
      result.targetAction.property = 'background';
    }
    
    // Text content change
    const textMatch = instruction.match(/(?:change|set|make)\s+(?:the\s+)?(.*?)\s+text\s+(?:to\s+)?["'](.*)["']/i);
    if (textMatch) {
      result.targetElement.text = textMatch[1].trim();
      result.targetAction.value = textMatch[2].trim();
      result.targetAction.type = 'text';
    }
    
    // Generic style change
    const styleMatch = instruction.match(/(?:change|set|make)\s+(?:the\s+)?(.*?)\s+(\w+)\s+(?:to\s+)?(\w+)/i);
    if (styleMatch) {
      result.targetElement.text = styleMatch[1].trim();
      result.targetAction.property = styleMatch[2].trim();
      result.targetAction.value = styleMatch[3].trim();
      result.targetAction.type = 'style';
    }
  }
  
  // Check if we have a valid element and action
  if (!result.targetElement.text || !result.targetAction.value) {
    console.warn(`⚠️ Could not fully parse instruction: "${instruction}"`);
  }
  
  return result;
}
