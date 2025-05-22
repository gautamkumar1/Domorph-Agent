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

// Add the import for the html-transformer
import { transformHtml, findRelevantElement } from './html-transformer.js';

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

// New function to design element changes using Claude
async function designElementChange(originalElement, instruction) {
  console.log(`🎨 Designing element change using Claude - Instruction: "${instruction}"`);
  console.log(`Original element: ${originalElement.substring(0, 100)}...`);
  
  // Get Anthropic API key from environment
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error("❌ Missing ANTHROPIC_API_KEY environment variable");
    throw new Error("Missing API key configuration");
  }
  
  // Extract the operation type from the instruction for better prompting
  const isColorChange = instruction.match(/(?:colou?r|background|bg)\\s+(?:to\\s+)?(\\w+)/i);
  const isRedesign = instruction.match(/redesign|make\\s+(?:it|this)\\s+/i);
  
  let promptStrategy;
  if (isColorChange) {
    promptStrategy = "color modification";
  } else if (isRedesign) {
    promptStrategy = "visual redesign";
  } else {
    promptStrategy = "general update";
  }
  
  // Build the prompt for Claude
  const promptParts = [
    `You are an expert web designer updating an HTML element. You need to modify the following HTML element according to this instruction: "${instruction}"`,
    ``,
    `Current HTML element:`,
    `\`\`\`html`,
    originalElement,
    `\`\`\``,
    ``,
    `IMPORTANT INSTRUCTIONS:`,
    `1. Return ONLY the modified HTML with NO explanation or markdown`,
    `2. Preserve all functionality (IDs, event handlers, attributes)`,
    `3. Only modify what's needed to fulfill the instruction`,
    `4. Maintain the same basic structure and content`,
    `5. Don't use utility class names like p-8 or text-lg`,
    `6. Don't add any comments or explanations in your response`,
    `7. The entire response should only be the HTML element, nothing else`
  ];
  
  try {
    // Call Claude to get the redesigned element
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet-20250219',
        max_tokens: 1500,
        temperature: 0.2,
        system: "You are a web designer who modifies HTML elements. Respond with only the modified HTML element without explanations or markdown. Never add any text before or after the HTML code.",
        messages: [
          {
            role: 'user',
            content: promptParts.join('\n')
          }
        ]
      })
    });
    
    if (!response.ok) {
      throw new Error(`API call failed with status: ${response.status}`);
    }
    
    const result = await response.json();
    let modifiedElement = result.content[0].text;
    
    // Clean up the response
    modifiedElement = modifiedElement
      .replace(/```(?:html)?|```/g, '') // Remove markdown code blocks
      .trim();
    
    // Ensure we're actually getting HTML back and not an explanation
    if (!modifiedElement.startsWith('<')) {
      // If Claude gave us an explanation, extract just the HTML
      const htmlMatch = modifiedElement.match(/<[^>]+>[\s\S]*<\/[^>]+>/);
      if (htmlMatch) {
        modifiedElement = htmlMatch[0];
      } else {
        throw new Error("Claude returned an explanation instead of HTML");
      }
    }
    
    console.log(`✅ Received modified element from Claude (${modifiedElement.length} chars)`);
    return modifiedElement;
    
  } catch (error) {
    console.error(`❌ Error redesigning element with Claude: ${error.message}`);
    throw error;
  }
}

// Add a new function to chunk HTML files intelligently
async function chunkHtmlForContext(html, instruction) {
  console.log(`🧩 Breaking HTML into semantic chunks for context`);
  
  // Use cheerio to parse the HTML
  const $ = cheerio.load(html);
  
  // Extract key sections based on semantic structure
  const chunks = [];
  
  // 1. Extract the head section (always important for styles/metadata)
  const headSection = $('head').html();
  if (headSection) {
    chunks.push({
      name: 'head',
      content: `<head>${headSection}</head>`,
      importance: 3 // Medium importance
    });
  }
  
  // 2. Extract main navigation
  const navElements = $('nav, header, .navbar, [role="navigation"]');
  if (navElements.length > 0) {
    navElements.each((i, el) => {
      chunks.push({
        name: `navigation-${i}`,
        content: $.html(el),
        importance: 3 // Medium importance
      });
    });
  }
  
  // 3. Extract main content sections
  const mainSections = $('main, article, section, .content, .container');
  if (mainSections.length > 0) {
    mainSections.each((i, el) => {
      chunks.push({
        name: `section-${i}`,
        content: $.html(el),
        importance: 4 // High importance
      });
    });
  }
  
  // 4. Extract individual components
  const components = $('div, aside, form');
  components.each((i, el) => {
    // Only include components that are not too small and have some meaningful content
    const html = $.html(el);
    if (html.length > 100 && ($(el).text().trim().length > 20 || $(el).find('button, input, a').length > 0)) {
      chunks.push({
        name: `component-${i}`,
        content: html,
        importance: 2 // Lower importance
      });
    }
  });
  
  // 5. Extract specific elements that might be targets for modification
  const targetElements = $('button, a.button, .btn, input[type="button"], input[type="submit"]');
  const buttonChunks = [];
  targetElements.each((i, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    const html = $.html(el);
    
    // Store all buttons but will score them later based on relevance to instruction
    buttonChunks.push({
      name: `button-${i}: ${text}`,
      content: html,
      text: text,
      element: el.tagName,
      importance: 2 // Default importance, will adjust based on relevance
    });
  });
  
  // 6. Score button chunks based on relevance to instruction
  if (instruction && buttonChunks.length > 0) {
    const lowerInstruction = instruction.toLowerCase();
    
    buttonChunks.forEach(chunk => {
      // Check if the button text is mentioned in the instruction
      if (chunk.text && lowerInstruction.includes(chunk.text.toLowerCase())) {
        chunk.importance = 5; // Highest importance for exact match
      } else if (chunk.text) {
        // Check for partial matches
        const words = chunk.text.toLowerCase().split(/\s+/);
        for (const word of words) {
          if (word.length > 3 && lowerInstruction.includes(word)) {
            chunk.importance = 4; // High importance for partial match
            break;
          }
        }
      }
    });
    
    // Add the button chunks to the main chunks array
    chunks.push(...buttonChunks);
  }
  
  // 7. Sort chunks by importance
  chunks.sort((a, b) => b.importance - a.importance);
  
  // 8. Build context object with metadata
  const context = {
    totalChunks: chunks.length,
    metadata: {
      title: $('title').text() || 'Untitled',
      url: $('link[rel="canonical"]').attr('href') || '',
      pageStructure: mainSections.length > 0 ? 
        mainSections.map((i, el) => $(el).attr('id') || $(el).attr('class') || `Section ${i}`).get() : 
        ['No clear sections found']
    },
    chunks: chunks
  };
  
  console.log(`✅ Generated ${chunks.length} semantic chunks from HTML`);
  return context;
}

// Function to build a prompt with the most relevant context for Claude
async function buildContextPrompt(file, instruction, maxTokens = 60000) {
  console.log(`📝 Building context-aware prompt for: "${instruction}"`);
  
  try {
    // Read the HTML file
    const baseDir = path.join(process.cwd(), "scraped_website");
    const filePath = path.join(baseDir, file);
    const content = await fs.readFile(filePath, 'utf-8');
    
    // Break the HTML into semantic chunks
    const context = await chunkHtmlForContext(content, instruction);
    
    // Build initial prompt components
    const promptParts = [
      `You are an expert web developer analyzing HTML code from the file "${file}".`,
      `The page title is: "${context.metadata.title}"`,
      `You are being asked to: "${instruction}"`,
      "Here are the most relevant parts of the HTML file for this task:"
    ];
    
    // Add chunks until we approach the context limit (rough estimation)
    let totalLength = promptParts.join('\n').length;
    let chunkCount = 0;
    
    // First, always include the highest importance chunks
    const highImportanceChunks = context.chunks.filter(chunk => chunk.importance >= 4);
    for (const chunk of highImportanceChunks) {
      const chunkText = `\n--- ${chunk.name} ---\n${chunk.content}`;
      if (totalLength + chunkText.length < maxTokens * 3.5) { // Rough character to token ratio
        promptParts.push(chunkText);
        totalLength += chunkText.length;
        chunkCount++;
      }
    }
    
    // Then add medium importance chunks
    const mediumImportanceChunks = context.chunks.filter(chunk => chunk.importance === 3);
    for (const chunk of mediumImportanceChunks) {
      const chunkText = `\n--- ${chunk.name} ---\n${chunk.content}`;
      if (totalLength + chunkText.length < maxTokens * 3.5) {
        promptParts.push(chunkText);
        totalLength += chunkText.length;
        chunkCount++;
      }
    }
    
    // Add final instructions
    promptParts.push(
      `\nYour task:`,
      `1. Based on the instruction "${instruction}", identify the specific HTML element(s) that need to be modified`,
      `2. Generate ONLY the modified HTML for the element(s) that need to change`,
      `3. Preserve all existing classes, IDs, and attributes except what specifically needs to be changed`,
      `4. Do not add new elements unless explicitly requested, only modify existing ones`,
      `5. Return ONLY the modified HTML element(s) without any explanation`
    );
    
    console.log(`✅ Built context prompt with ${chunkCount} chunks out of ${context.totalChunks} total chunks`);
    return promptParts.join('\n');
  } catch (error) {
    console.error(`❌ Error building context prompt:`, error);
    throw error;
  }
}

// Add a function to parse batch operations and advanced selectors from natural language
function parseAdvancedSelectors(instruction) {
  console.log(`🔍 Analyzing instruction for advanced selectors: "${instruction}"`);
  
  const result = {
    isBatchOperation: false,
    isFullPageRedesign: false,
    selectors: [],
    instruction: instruction
  };
  
  // Check for full page redesign patterns
  const fullPagePatterns = [
    /redesign (the )?full page/i,
    /redesign (the )?entire page/i,
    /redesign (the )?whole page/i,
    /change (the )?layout of/i,
    /completely redesign/i,
    /overhaul the/i,
    /redo the (entire|whole)/i
  ];
  
  for (const pattern of fullPagePatterns) {
    if (pattern.test(instruction)) {
      result.isFullPageRedesign = true;
      break;
    }
  }
  
  // Check for batch operations with "all" pattern
  const allPattern = /\b(all|every)\s+(\w+)s?\b/i;
  const allMatch = instruction.match(allPattern);
  
  if (allMatch) {
    result.isBatchOperation = true;
    const elementType = allMatch[2].toLowerCase();
    
    // Map common element types to their selectors
    const elementMappings = {
      'button': 'button, .btn, .button, a[role="button"], input[type="button"], input[type="submit"]',
      'link': 'a',
      'input': 'input',
      'image': 'img',
      'heading': 'h1, h2, h3, h4, h5, h6',
      'paragraph': 'p',
      'header': 'header',
      'footer': 'footer',
      'section': 'section',
      'card': '.card, .box, .panel',
      'icon': 'i, .icon, svg',
      'menu': 'nav, .menu, .navbar',
      'field': 'input, textarea, select',
      'form': 'form'
    };
    
    // Add the appropriate selector
    if (elementMappings[elementType]) {
      result.selectors.push(elementMappings[elementType]);
    } else {
      // For unknown elements, use the element name as tag
      result.selectors.push(elementType);
    }
  }
  
  // Check for specific element groups by color, size, or style
  const attributePatterns = [
    { regex: /(\w+)\s+with\s+color\s+(\w+)/i, selector: (matches) => `${matches[1]}[style*="color: ${matches[2]}"], ${matches[1]}[class*="${matches[2]}"]` },
    { regex: /(\w+)\s+with\s+background\s+(\w+)/i, selector: (matches) => `${matches[1]}[style*="background: ${matches[2]}"], ${matches[1]}[style*="background-color: ${matches[2]}"], ${matches[1]}[class*="${matches[2]}-bg"]` },
    { regex: /(\w+)\s+in\s+the\s+(\w+)/i, selector: (matches) => `.${matches[2]} ${matches[1]}, #${matches[2]} ${matches[1]}` }
  ];
  
  attributePatterns.forEach(pattern => {
    const matches = instruction.match(pattern.regex);
    if (matches) {
      result.isBatchOperation = true;
      result.selectors.push(pattern.selector(matches));
    }
  });
  
  return result;
}

// Fix fullPageRedesign function to improve prompt instructions
async function fullPageRedesign(html, instruction) {
  console.log(`🎨 Performing full page redesign based on: "${instruction}"`);
  
  // Get Anthropic API key
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw new Error("Missing ANTHROPIC_API_KEY environment variable");
  }
  
  try {
    // Create a prompt specifically for full page redesign - with more explicit instructions
    const promptParts = [
      `You are an expert web designer and developer. You have been asked to redesign an HTML page according to the following instruction:`,
      `"${instruction}"`,
      ``,
      `The current HTML is:`,
      `\`\`\`html`,
      html.substring(0, 100000), // Include as much of the HTML as we can within token limits
      `\`\`\``,
      ``,
      `EXTREMELY IMPORTANT GUIDELINES:`,
      `1. RETURN ONLY THE FULL HTML WITH NO EXPLANATION, COMMENTARY, OR MARKDOWN. Just return the raw HTML document.`,
      `2. Preserve all functionality, IDs, form actions, and core structure`,
      `3. Maintain all content and text unless explicitly told to change it`,
      `4. Focus on visual improvements like colors, spacing, typography, and layout`,
      `5. Use standard CSS classes and properties, NOT utility classes like "p-8" or "text-lg" directly in selectors`,
      `6. You can add classes but keep original class names where possible`,
      `7. Make sure all scripts and important attributes are preserved`,
      `8. DO NOT prefix your response with phrases like "Here's the redesigned HTML" or similar explanations`,
      `9. Start your response with <!DOCTYPE html> and end with </html> with no other text`
    ];
    
    // Call Claude with the redesign prompt
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet-20250219',
        max_tokens: 4000,
        temperature: 0.3,
        system: "You are an expert web designer who responds with clean, valid HTML code only. Never include explanations or commentary. Your response should start with <!DOCTYPE html> and contain only HTML code.",
        messages: [
          {
            role: 'user',
            content: promptParts.join('\n')
          }
        ]
      })
    });
    
    if (!response.ok) {
      throw new Error(`Error from Anthropic API: ${response.status}`);
    }
    
    const result = await response.json();
    let redesignedHtml = result.content[0].text;
    
    // Ensure we're getting a proper HTML document
    if (!redesignedHtml.trim().startsWith('<!DOCTYPE') && 
        !redesignedHtml.trim().startsWith('<html') && 
        !redesignedHtml.trim().startsWith('<head') && 
        !redesignedHtml.trim().startsWith('```html')) {
      console.error("Response doesn't appear to be valid HTML:", redesignedHtml.substring(0, 100));
      throw new Error("Claude did not return valid HTML");
    }
    
    // Clean up the response (remove markdown and any explanations)
    const cleanHtml = redesignedHtml
      .replace(/```(?:html)?\s*([\s\S]*?)\s*```/g, '$1')
      .trim();
    
    return cleanHtml;
  } catch (error) {
    console.error("Error in full page redesign:", error);
    throw error;
  }
}

// Fix batchElementUpdate function to handle CSS more carefully
async function batchElementUpdate(html, selectors, instruction) {
  console.log(`🔄 Performing batch update on elements matching: ${selectors.join(', ')}`);
  
  // Get Anthropic API key
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw new Error("Missing ANTHROPIC_API_KEY environment variable");
  }
  
  // Load the HTML with cheerio
  const $ = cheerio.load(html);
  
  // Find all elements matching the selectors
  const elements = [];
  selectors.forEach(selector => {
    try {
      $(selector).each((i, el) => {
        elements.push({
          selector: selector,
          html: $.html(el),
          index: i
        });
      });
    } catch (error) {
      console.warn(`Error finding elements with selector "${selector}": ${error.message}`);
      // Continue with other selectors
    }
  });
  
  console.log(`Found ${elements.length} elements matching the selectors`);
  
  if (elements.length === 0) {
    throw new Error(`No elements found matching selectors: ${selectors.join(', ')}`);
  }
  
  // If there are too many elements, just get the first few as examples
  const maxExamples = 5;
  const examples = elements.length > maxExamples ? elements.slice(0, maxExamples) : elements;
  
  // Create a prompt for batch updating elements - with improved instructions
  const promptParts = [
    `You are an expert web designer modifying HTML elements. You need to update ALL elements of a certain type according to this instruction:`,
    `"${instruction}"`,
    ``,
    `Here are ${examples.length} examples of the elements you need to modify (there are ${elements.length} total):`,
  ];
  
  examples.forEach((element, i) => {
    promptParts.push(`Example ${i+1}:`);
    promptParts.push('```html');
    promptParts.push(element.html);
    promptParts.push('```');
    promptParts.push('');
  });
  
  promptParts.push(`Please provide a CSS rule that can be applied to the selector "${selectors.join(', ')}" to achieve the requested change.`);
  promptParts.push('Also provide one example of how the HTML for the first element should be modified, if HTML changes are needed.');
  promptParts.push('');
  promptParts.push('IMPORTANT: Use only standard CSS properties and valid CSS syntax. DO NOT use utility class names like p-8, text-lg, etc. as selectors.');
  promptParts.push('');
  promptParts.push('Format your answer exactly as follows with no additional text or explanation:');
  promptParts.push('```css');
  promptParts.push('/* CSS rule here */');
  promptParts.push('```');
  promptParts.push('```html');
  promptParts.push('<!-- HTML example here -->');
  promptParts.push('```');
  
  // Call Claude to get the modifications
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-7-sonnet-20250219',
      max_tokens: 2000,
      temperature: 0.2,
      system: "You are a CSS and HTML expert. Respond only with code blocks for CSS and HTML without any explanation. Use only standard CSS properties, not utility class names as selectors.",
      messages: [
        {
          role: 'user',
          content: promptParts.join('\n')
        }
      ]
    })
  });
  
  if (!response.ok) {
    throw new Error(`Error from Anthropic API: ${response.status}`);
  }
  
  const result = await response.json();
  const claudeResponse = result.content[0].text;
  
  // Extract CSS rules
  const cssMatch = claudeResponse.match(/```css\s*([\s\S]*?)\s*```/);
  let cssRules = cssMatch ? cssMatch[1].trim() : null;
  
  // Sanitize CSS rules to remove any invalid selectors that might cause errors
  if (cssRules) {
    // Replace any possible utility class usage in selectors
    cssRules = cssRules.replace(/:[a-z]+-[0-9]+/g, ''); // Remove things like :p-8, :text-lg
    
    // Make sure selector doesn't use classes that look like utilities
    const potentialUtilityClasses = [/\.[mp][trblxy]?-\d+/, /\.text-\w+/, /\.bg-\w+/, /\.flex-\w+/];
    potentialUtilityClasses.forEach(pattern => {
      cssRules = cssRules.replace(pattern, '');
    });
  }
  
  // Extract HTML example
  const htmlMatch = claudeResponse.match(/```html\s*([\s\S]*?)\s*```/);
  const htmlExample = htmlMatch ? htmlMatch[1].trim() : null;
  
  console.log(`Extracted CSS rules: ${cssRules ? 'Yes' : 'No'}`);
  console.log(`Extracted HTML example: ${htmlExample ? 'Yes' : 'No'}`);
  
  // Apply the changes to all matching elements
  if (cssRules) {
    // Add the CSS to the head
    const styleTag = `<style>${cssRules}</style>`;
    const headTag = $('head');
    if (headTag.length > 0) {
      headTag.append(styleTag);
    } else {
      $('html').prepend(`<head>${styleTag}</head>`);
    }
  }
  
  // If HTML changes are needed, use the example to guide individual element updates
  if (htmlExample) {
    try {
      const $example = cheerio.load(htmlExample);
      const exampleEl = $example.root().children().first();
      
      // Apply similar changes to all matching elements
      selectors.forEach(selector => {
        try {
          $(selector).each((i, el) => {
            const $el = $(el);
            
            // Transfer attributes from example
            const exampleAttrs = exampleEl[0].attribs;
            for (const attr in exampleAttrs) {
              if (attr !== 'id') { // Don't override IDs
                $el.attr(attr, exampleAttrs[attr]);
              }
            }
            
            // If the instruction mentions changing text and the example has different text
            if (instruction.includes('text') && exampleEl.text() !== $el.text()) {
              // Only apply text changes for instruction about text
              if (instruction.includes('text') || instruction.includes('content')) {
                $el.text(exampleEl.text());
              }
            }
          });
        } catch (error) {
          console.warn(`Error applying changes to selector "${selector}": ${error.message}`);
        }
      });
    } catch (error) {
      console.error(`Error processing HTML example: ${error.message}`);
    }
  }
  
  // Return the updated HTML
  return $.html();
}

// Add a new comprehensive HTML transformer that handles any HTML transformation with Claude
async function transformHtmlWithClaude(html, instruction, transformationType = 'auto') {
  console.log(`🔄 Transforming HTML with Claude - Type: ${transformationType}, Instruction: "${instruction}"`);
  
  // Get Anthropic API key
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw new Error("Missing ANTHROPIC_API_KEY environment variable");
  }
  
  // Determine the transformation type if set to auto
  if (transformationType === 'auto') {
    // Check for full page redesign patterns
    const fullPagePatterns = [
      /redesign (the )?full page/i,
      /redesign (the )?entire page/i,
      /redesign (the )?whole page/i,
      /change (the )?layout of/i,
      /completely redesign/i,
      /overhaul the/i,
      /redo the (entire|whole)/i
    ];
    
    for (const pattern of fullPagePatterns) {
      if (pattern.test(instruction)) {
        transformationType = 'full-page';
        break;
      }
    }
    
    // Check for batch operations with "all" pattern
    if (transformationType === 'auto') {
      const allPattern = /\b(all|every)\s+(\w+)s?\b/i;
      if (allPattern.test(instruction)) {
        transformationType = 'batch-elements';
      }
    }
    
    // Default to single element if not determined
    if (transformationType === 'auto') {
      transformationType = 'single-element';
    }
  }
  
  console.log(`Determined transformation type: ${transformationType}`);
  
  // Build appropriate prompt based on transformation type
  let promptParts = [];
  let systemPrompt = "";
  
  if (transformationType === 'full-page') {
    // Full page redesign prompt
    promptParts = [
      `You are an expert web designer and developer redesigning an entire HTML page based on this instruction: "${instruction}"`,
      ``,
      `Current HTML page:`,
      `\`\`\`html`,
      html,
      `\`\`\``,
      ``,
      `EXTREMELY IMPORTANT RULES:`,
      `1. Return ONLY valid HTML with NO explanations or markdown - just the raw HTML document`,
      `2. Preserve all functionality, IDs, form handlers, and script tags`,
      `3. Maintain all original content and text unless specifically instructed to change it`,
      `4. Start with <!DOCTYPE html> and end with </html>`,
      `5. Use proper CSS syntax - no utility class names in selectors (no :p-8 or similar)`,
      `6. Make sure all original attributes are preserved unless they need to be changed`,
      `7. DO NOT add any commentary or explanation before or after the HTML`
    ];
    
    systemPrompt = "You are a web design AI that returns only complete, valid HTML documents. Never include explanations, markdown formatting, or commentary with your response. Your output should be a complete HTML document that starts with <!DOCTYPE html> and contains all necessary elements.";
  } 
  else if (transformationType === 'batch-elements') {
    // Extract the element type from the instruction
    const allPattern = /\b(all|every)\s+(\w+)s?\b/i;
    const allMatch = instruction.match(allPattern);
    const elementType = allMatch ? allMatch[2].toLowerCase() : 'elements';
    
    // Map common element types to their selectors
    const elementMappings = {
      'button': 'button, .btn, .button, a[role="button"], input[type="button"], input[type="submit"]',
      'link': 'a',
      'input': 'input',
      'image': 'img',
      'heading': 'h1, h2, h3, h4, h5, h6',
      'paragraph': 'p',
      'header': 'header',
      'footer': 'footer',
      'section': 'section',
      'card': '.card, .box, .panel',
      'icon': 'i, .icon, svg',
      'menu': 'nav, .menu, .navbar',
      'field': 'input, textarea, select',
      'form': 'form'
    };
    
    // Create selector
    const selector = elementMappings[elementType] || elementType;
    
    // Load the HTML with cheerio
    const $ = cheerio.load(html);
    
    // Find all matching elements
    const matchingElements = [];
    try {
      $(selector).each((i, el) => {
        if (matchingElements.length < 5) { // Limit to 5 examples
          matchingElements.push($.html(el));
        }
      });
    } catch (error) {
      console.warn(`Error with selector "${selector}": ${error.message}`);
    }
    
    // Build prompt with examples of the elements
    promptParts = [
      `You are an expert web designer modifying multiple HTML elements. You need to update all ${elementType} elements based on this instruction: "${instruction}"`,
      ``,
      `Here are examples of the elements to modify:`,
    ];
    
    matchingElements.forEach((element, i) => {
      promptParts.push(`Example ${i+1}:`);
      promptParts.push('```html');
      promptParts.push(element);
      promptParts.push('```');
    });
    
    promptParts.push(``);
    promptParts.push(`INSTRUCTIONS:`);
    promptParts.push(`1. Provide a complete <style> tag with CSS rules to apply to all ${elementType} elements`);
    promptParts.push(`2. Also provide ONE complete HTML example of how these elements should be modified`);
    promptParts.push(`3. Use standard CSS syntax - no utility classes as selectors`);
    promptParts.push(`4. Return ONLY the <style> tag and ONE modified element example with no explanations`);
    promptParts.push(`5. Format your response exactly like this:`);
    promptParts.push(`<style>`);
    promptParts.push(`/* Your CSS here */`);
    promptParts.push(`</style>`);
    promptParts.push(``);
    promptParts.push(`<!-- Modified element example -->`);
    promptParts.push(`<element>Your modified element here</element>`);
    
    systemPrompt = "You are a CSS and HTML expert. Respond with only the requested <style> tag and HTML example with no explanations or markdown. Use standard CSS properties and valid syntax.";
  } 
  else {
    // Single element transformation prompt
    promptParts = [
      `You are an expert web designer modifying an HTML element based on this instruction: "${instruction}"`,
      ``,
      `Current HTML element:`,
      `\`\`\`html`,
      html,
      `\`\`\``,
      ``,
      `IMPORTANT RULES:`,
      `1. Return ONLY the modified HTML element with NO explanations or markdown`,
      `2. Preserve all functionality (IDs, classes, event handlers, attributes)`,
      `3. Only modify what's needed to fulfill the instruction`,
      `4. Start your response with the opening HTML tag and end with closing tag`,
      `5. Use proper CSS syntax for any style changes`,
      `6. DO NOT add any commentary or explanation`
    ];
    
    systemPrompt = "You are a web design AI that returns only the modified HTML element. Never include explanations, markdown formatting, or commentary. Your output should be only the requested HTML element code.";
  }
  
  try {
    // Call Claude API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet-20250219',
        max_tokens: transformationType === 'full-page' ? 4000 : 2000,
        temperature: 0.2,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: promptParts.join('\n')
          }
        ]
      })
    });
    
    if (!response.ok) {
      throw new Error(`Error from Anthropic API: ${response.status}`);
    }
    
    const result = await response.json();
    let modifiedHtml = result.content[0].text.trim();
    
    // Clean up Claude's response
    modifiedHtml = modifiedHtml
      .replace(/```(?:html|css)?\s*([\s\S]*?)\s*```/g, '$1')
      .trim();
    
    // Basic validation based on transformation type
    if (transformationType === 'full-page' && 
        !modifiedHtml.includes('<!DOCTYPE html>') && 
        !modifiedHtml.startsWith('<html') && 
        !modifiedHtml.startsWith('<head')) {
      console.warn("Claude's response doesn't look like a full HTML page:", modifiedHtml.substring(0, 100));
      throw new Error("Invalid full page HTML response from Claude");
    }
    
    if (transformationType === 'single-element' && !modifiedHtml.startsWith('<')) {
      console.warn("Claude's response doesn't look like an HTML element:", modifiedHtml.substring(0, 100));
      
      // Try to extract HTML from response if present
      const htmlMatch = modifiedHtml.match(/<[^>]+>[\s\S]*<\/[^>]+>/);
      if (htmlMatch) {
        modifiedHtml = htmlMatch[0];
      } else {
        throw new Error("Invalid HTML element response from Claude");
      }
    }
    
    console.log(`✅ Successfully transformed HTML (${modifiedHtml.length} chars)`);
    return modifiedHtml;
    
  } catch (error) {
    console.error(`❌ Error transforming HTML with Claude:`, error);
    throw error;
  }
}

// Add a new function to apply CSS and HTML changes from Claude to multiple elements
async function applyBatchChanges(html, instruction) {
  try {
    console.log(`🔄 Applying batch changes based on: "${instruction}"`);
    
    // Get the transformation result from Claude
    const transformResult = await transformHtmlWithClaude(html, instruction, 'batch-elements');
    
    // Extract the style tag
    const styleMatch = transformResult.match(/<style>([\s\S]*?)<\/style>/);
    const cssRules = styleMatch ? styleMatch[1] : null;
    
    // Extract the example element
    const elementMatch = transformResult.match(/<!--[\s\S]*?-->\s*(<[\s\S]*>)/);
    const elementExample = elementMatch ? elementMatch[1] : null;
    
    if (!cssRules && !elementExample) {
      throw new Error("Claude did not return valid CSS or HTML example");
    }
    
    // Parse the instruction to identify target elements
    const advancedSelectors = parseAdvancedSelectors(instruction);
    
    // Load the HTML with cheerio
    const $ = cheerio.load(html);
    
    // Add CSS rules if present
    if (cssRules) {
      console.log(`Adding CSS rules to the document`);
      const styleTag = `<style>${cssRules}</style>`;
      
      // Add to head if it exists, otherwise create one
      const headTag = $('head');
      if (headTag.length > 0) {
        headTag.append(styleTag);
      } else {
        $('html').prepend(`<head>${styleTag}</head>`);
      }
    }
    
    // Apply HTML changes from the example if present
    if (elementExample) {
      console.log(`Applying HTML changes from example to matching elements`);
      
      // Parse the example
      const $example = cheerio.load(elementExample);
      const exampleEl = $example.root().children().first();
      
      // Apply to all matching elements
      advancedSelectors.selectors.forEach(selector => {
        try {
          console.log(`Applying changes to elements matching: ${selector}`);
          let updateCount = 0;
          
          $(selector).each((i, el) => {
            const $el = $(el);
            
            // Transfer attributes from example
            const exampleAttrs = exampleEl[0].attribs || {};
            for (const attr in exampleAttrs) {
              if (attr !== 'id') { // Don't override IDs
                $el.attr(attr, exampleAttrs[attr]);
              }
            }
            
            // If the instruction mentions text or content, update the text
            if ((instruction.includes('text') || instruction.includes('content')) && 
                exampleEl.text() !== $el.text()) {
              $el.html(exampleEl.html());
            }
            
            updateCount++;
          });
          
          console.log(`Updated ${updateCount} elements matching selector: ${selector}`);
        } catch (error) {
          console.warn(`Error applying changes to selector "${selector}": ${error.message}`);
        }
      });
    }
    
    return $.html();
  } catch (error) {
    console.error(`Error applying batch changes:`, error);
    throw error;
  }
}

// Replace the existing intelligentHtmlUpdate function with a new implementation using the transformer
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
    
    // Use the new HTML transformer to transform the HTML
    // The transformer will automatically detect the type of transformation needed
    const transformedHtml = await transformHtml(content, instruction);
    
    // Write the updated content back to the file
    await fs.writeFile(filePath, transformedHtml, 'utf-8');
    
    // Restart the server
    await restartServer(baseDir);
    
    return { 
      success: true, 
      message: `Successfully updated ${file} based on instruction: "${instruction}"`,
      serverUrl: `http://localhost:3030/scraped_website/`,
      update: {
        type: 'claude-html-transform',
        instruction: instruction
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
    // Background color change - improved pattern
    const bgColorMatch = instruction.match(/(?:change|set|make|changed)\s+(?:the\s+)?(.*?)\s+(?:background|bg)\s+(?:colour|color)\s+(?:to\s+)?(\w+)/i);
    if (bgColorMatch) {
      result.targetElement.text = bgColorMatch[1].trim();
      result.targetAction.value = bgColorMatch[2].trim();
      result.targetAction.type = 'color';
      result.targetAction.property = 'background-color'; // Explicitly use background-color
    }
    
    // Text content change
    const textMatch = instruction.match(/(?:change|set|make)\s+(?:the\s+)?(.*?)\s+text\s+(?:to\s+)?["'](.*)["']/i);
    if (textMatch) {
      result.targetElement.text = textMatch[1].trim();
      result.targetAction.value = textMatch[2].trim();
      result.targetAction.type = 'text';
    }
    
    // Redesign instruction
    const redesignMatch = instruction.match(/redesign\s+(?:the\s+)?(.*?)(?:\s+to\s+|\s+$)/i);
    if (redesignMatch) {
      result.targetElement.text = redesignMatch[1].trim();
      result.targetAction.type = 'redesign';
      result.targetAction.value = instruction;
    }
    
    // "Make X more Y" pattern (enhancement instructions)
    const enhanceMatch = instruction.match(/make\s+(?:the\s+)?(.*?)\s+more\s+(\w+)/i);
    if (enhanceMatch) {
      result.targetElement.text = enhanceMatch[1].trim();
      result.targetAction.type = 'enhance';
      result.targetAction.value = enhanceMatch[2].trim();
    }
    
    // Generic style change
    const styleMatch = instruction.match(/(?:change|set|make)\s+(?:the\s+)?(.*?)\s+(\w+)\s+(?:to\s+)?(\w+)/i);
    if (styleMatch && !result.targetElement.text) {
      result.targetElement.text = styleMatch[1].trim();
      result.targetAction.property = styleMatch[2].trim();
      result.targetAction.value = styleMatch[3].trim();
      result.targetAction.type = 'style';
    }
  }
  
  // Check if we have a valid element and action
  if (!result.targetElement.text || !result.targetAction.value) {
    console.warn(`⚠️ Could not fully parse instruction: "${instruction}"`);
    
    // Fallback: if we can't parse properly, extract any text that might be a button name
    const buttonNameMatch = instruction.match(/(?:the\s+)([\w\s]+)(?:\s+button)/i);
    if (buttonNameMatch) {
      result.targetElement.text = buttonNameMatch[1].trim();
      result.targetElement.type = 'button';
      result.targetAction.type = 'redesign';
      result.targetAction.value = instruction;
    }
  }
  
  console.log(`Parsed instruction result:`, JSON.stringify(result, null, 2));
  return result;
}
