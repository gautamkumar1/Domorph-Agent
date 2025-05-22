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
  const isColorChange = instruction.match(/(?:colou?r|background|bg)\s+(?:to\s+)?(\w+)/i);
  const isRedesign = instruction.match(/redesign|make\s+(?:it|this)\s+(?:more|better|nicer)/i);
  
  // Create a more specific prompt based on instruction type
  let promptContent;
  
  if (isColorChange) {
    // For color changes, be very specific
    promptContent = `
You are an expert web designer and HTML/CSS specialist. Your task is to modify an HTML element's color based on the user instruction.

ORIGINAL HTML ELEMENT:
\`\`\`html
${originalElement}
\`\`\`

USER INSTRUCTION: "${instruction}"

Your task:
1. ONLY modify the color properties specified in the instruction (text color or background color)
2. DO NOT add any new elements or remove existing ones
3. Preserve ALL existing classes, IDs, and other attributes
4. Return ONLY the modified HTML element

Rules for color changes:
- If the instruction mentions "background color" or "bg color", modify the background-color CSS property
- If the instruction just mentions "color", modify the color (text color) CSS property
- Add the color either as an inline style or by adding/modifying a class as appropriate
- Use the exact color specified in the instruction

Modified HTML element:`;
  } else if (isRedesign) {
    // For redesign requests, emphasize modifying not adding
    promptContent = `
You are an expert web designer and HTML/CSS specialist. Your task is to redesign an existing HTML element based on the user instruction.

ORIGINAL HTML ELEMENT:
\`\`\`html
${originalElement}
\`\`\`

USER INSTRUCTION: "${instruction}"

Your task:
1. MODIFY the EXISTING element - DO NOT create or add new elements
2. Preserve the element type, ID, and essential attributes
3. You can add or modify classes and styles to improve the design
4. You can modify the element's content if requested, but keep the same basic content
5. Ensure the element's functionality is maintained
6. Return ONLY the modified HTML element

Example of acceptable changes:
- Adding inline styles
- Modifying existing style attributes
- Adding CSS classes for styling
- Tweaking the element structure while keeping its core functionality
- Adjusting padding, margins, borders, etc.

Example of unacceptable changes:
- Adding completely new elements
- Changing a button to a div or another element type
- Removing important attributes like onclick handlers
- Completely changing the element's content unless specifically requested

Modified HTML element:`;
  } else {
    // Generic prompt for other types of changes
    promptContent = `
You are an expert web designer and HTML/CSS specialist. Your task is to modify an HTML element based on a user instruction.

ORIGINAL HTML ELEMENT:
\`\`\`html
${originalElement}
\`\`\`

USER INSTRUCTION: "${instruction}"

Your task:
1. Apply ONLY the requested changes to this HTML element
2. DO NOT add new elements - modify the existing one
3. Maintain all existing classes, IDs, and attributes except what needs to be changed
4. Follow modern web design principles
5. Ensure the element remains functional
6. Return ONLY the modified HTML element with no explanation

Modified HTML element:`;
  }
  
  try {
    // Send request to Claude
    console.log(`🤖 Sending request to Anthropic API to design element change...`);
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet-20250219',
        max_tokens: 1000,
        temperature: 0.2,
        messages: [
          {
            role: 'user',
            content: promptContent
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
    const modifiedElement = result.content[0].text.trim();
    
    // Remove any markdown code block formatting if present
    const cleanElement = modifiedElement.replace(/```(?:html)?\s*([\s\S]*?)\s*```/g, '$1').trim();
    
    console.log(`✅ Successfully designed element change`);
    console.log(`Modified element: ${cleanElement.substring(0, 100)}...`);
    
    return cleanElement;
  } catch (error) {
    console.error(`❌ Error designing element change:`, error);
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

// Enhanced intelligentHtmlUpdate function to use context-aware prompts
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
    
    // Check if this is a specific element update or a general natural language command
    const isNaturalLanguageCommand = 
      targetAction.type === 'redesign' || 
      instruction.includes('make it') || 
      instruction.toLowerCase().includes('change') || 
      !targetElement.text;
    
    if (isNaturalLanguageCommand) {
      console.log(`🌟 Processing as natural language command`);
      
      try {
        // Build a context-aware prompt
        const contextPrompt = await buildContextPrompt(file, instruction);
        
        // Get Anthropic API key
        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        if (!anthropicKey) {
          throw new Error("Missing ANTHROPIC_API_KEY environment variable");
        }
        
        // Call Claude with the context-rich prompt
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
            messages: [
              {
                role: 'user',
                content: contextPrompt
              }
            ]
          })
        });
        
        if (!response.ok) {
          throw new Error(`Error from Anthropic API: ${response.status}`);
        }
        
        const result = await response.json();
        const modifiedHtml = result.content[0].text.trim();
        
        // Clean up the response (remove markdown and any explanations)
        const cleanHtml = modifiedHtml
          .replace(/```(?:html)?\s*([\s\S]*?)\s*```/g, '$1')
          .trim();
        
        console.log(`✅ Received modified HTML from Claude`);
        
        // Load the full document
        const $ = cheerio.load(content);
        
        // Create a temporary DOM to parse the modified HTML
        const $modified = cheerio.load(`<div id="claude-output">${cleanHtml}</div>`);
        
        // Extract the element(s) from Claude's response
        const $elementFromClaude = $modified('#claude-output').children();
        
        if ($elementFromClaude.length === 0) {
          throw new Error("Claude did not return any valid HTML elements");
        }
        
        console.log(`Found ${$elementFromClaude.length} elements in Claude's response`);
        
        // Try to identify where to insert each element in the original document
        let updatedContent = content;
        let updateCount = 0;
        
        $elementFromClaude.each((i, el) => {
          const $el = $modified(el);
          const tagName = el.tagName;
          const id = $el.attr('id');
          const className = $el.attr('class');
          const text = $el.text().trim();
          
          console.log(`Looking for matching element: ${tagName}${id ? `#${id}` : ''}${className ? `.${className}` : ''} with text "${text.substring(0, 30)}..."`);
          
          // Try various ways to find the matching element in the original document
          let $matchingElements = [];
          
          // 1. Try by ID if available (most specific)
          if (id) {
            $matchingElements = $(`#${id}`);
          }
          
          // 2. Try by tag and class combination
          if ($matchingElements.length === 0 && className) {
            $matchingElements = $(`${tagName}.${className.replace(/\s+/g, '.')}`);
          }
          
          // 3. Try by text content for buttons and links
          if ($matchingElements.length === 0 && text && ['button', 'a'].includes(tagName.toLowerCase())) {
            $matchingElements = $(tagName).filter(function() {
              return $(this).text().trim() === text;
            });
          }
          
          // 4. Try partial text matching as last resort
          if ($matchingElements.length === 0 && text && text.length > 10) {
            const textPattern = text.substring(0, 10).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            $matchingElements = $('*').filter(function() {
              return $(this).text().includes(text.substring(0, 10));
            });
          }
          
          // If we found matching elements, replace the first one
          if ($matchingElements.length > 0) {
            console.log(`✅ Found ${$matchingElements.length} matching elements in the original document`);
            
            // Get the HTML of the original element and the replacement
            const originalHtml = $.html($matchingElements.first());
            const replacementHtml = $modified.html($el);
            
            // Replace in the document
            updatedContent = updatedContent.replace(originalHtml, replacementHtml);
            updateCount++;
          } else {
            console.warn(`⚠️ Could not find a matching element for ${tagName} in the original document`);
          }
        });
        
        if (updateCount === 0) {
          throw new Error("Could not find any matching elements to update");
        }
        
        // Write the updated content back to the file
        await fs.writeFile(filePath, updatedContent, 'utf-8');
        
        // Restart the server
        await restartServer(baseDir);
        
        return { 
          success: true, 
          message: `Successfully applied natural language update to ${file}: "${instruction}"`,
          serverUrl: `http://localhost:3030/scraped_website/`,
          update: {
            elementCount: updateCount,
            instruction: instruction
          }
        };
        
      } catch (error) {
        console.error(`❌ Error with natural language update:`, error);
        // Fall back to the existing implementation
        console.log(`⚠️ Falling back to standard element targeting`);
      }
    }
    
    // Continue with the existing implementation for specific element updates
    const $ = cheerio.load(content);
    
    // Find the target element - enhanced targeting approach
    let $targetElement;
    let allCandidates = [];
    
    // Log what we're looking for
    console.log(`Looking for ${targetElement.type} with text: "${targetElement.text}"`);
    
    // Try different search strategies with increasing flexibility
    // 1. First try: exact button match
    if (targetElement.type === 'button') {
      $targetElement = $('button').filter(function() {
        const buttonText = $(this).text().trim();
        return buttonText === targetElement.text.trim();
      });
      
      if ($targetElement.length > 0) {
        console.log(`Found exact button match with text: "${targetElement.text}"`);
      }
    }
    
    // 2. Second try: contains match for buttons
    if (!$targetElement || $targetElement.length === 0) {
      $targetElement = $('button').filter(function() {
        return $(this).text().toLowerCase().includes(targetElement.text.toLowerCase());
      });
      
      if ($targetElement.length > 0) {
        console.log(`Found button containing text: "${targetElement.text}"`);
      }
    }
    
    // 3. Third try: button-like elements
    if (!$targetElement || $targetElement.length === 0) {
      $targetElement = $('a, div, span').filter(function() {
        // Check if this element likely represents a button
        const classes = $(this).attr('class') || '';
        const hasButtonClass = classes.toLowerCase().includes('button') || 
                               classes.toLowerCase().includes('btn');
        const hasButtonStyles = $(this).css('cursor') === 'pointer' || 
                               $(this).css('padding') !== undefined;
        const isClickable = $(this).attr('onclick') !== undefined || 
                           $(this).attr('href') !== undefined;
        
        // Check if the text closely matches
        const elementText = $(this).text().trim().toLowerCase();
        const targetText = targetElement.text.trim().toLowerCase();
        const textMatches = elementText.includes(targetText) || 
                           targetText.includes(elementText);
        
        return textMatches && (hasButtonClass || hasButtonStyles || isClickable);
      });
      
      if ($targetElement.length > 0) {
        console.log(`Found button-like element with text: "${targetElement.text}"`);
      }
    }
    
    // 4. Fourth try: generic text-containing elements
    if (!$targetElement || $targetElement.length === 0) {
      $targetElement = $('*').filter(function() {
        if ($(this).is('html, body, head, script, style')) {
          return false;
        }
        
        const elementText = $(this).text().trim().toLowerCase();
        const targetText = targetElement.text.trim().toLowerCase();
        
        // Only match if this element itself contains the text directly (not just its children)
        const childrenText = $(this).children().text().trim().toLowerCase();
        const hasTextDirectly = elementText.includes(targetText) && 
                               (elementText.length - childrenText.length > 0);
        
        return hasTextDirectly;
      });
      
      if ($targetElement.length > 0) {
        console.log(`Found generic element containing text: "${targetElement.text}"`);
      }
    }
    
    // If no elements found, fall back to LLM-based approach
    if (!$targetElement || $targetElement.length === 0) {
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
    
    // If we found multiple matches, use the first one but log a warning
    if ($targetElement.length > 1) {
      console.warn(`⚠️ Found ${$targetElement.length} matching elements, using the first one`);
      // Keep only the first match
      $targetElement = $targetElement.first();
    }
    
    console.log(`✅ Found matching element: ${$targetElement.length > 0}`);
    
    // Store original HTML for comparison
    const originalHtml = $.html();
    const originalElementHtml = $.html($targetElement);
    console.log(`Original element HTML: ${originalElementHtml.substring(0, 100)}...`);
    
    // NEW: Use Claude to design the element change
    let modifiedElementHtml;
    try {
      // Send the original element to Claude for design modification
      modifiedElementHtml = await designElementChange(originalElementHtml, instruction);
    } catch (claudeError) {
      console.warn(`⚠️ Claude design failed, falling back to basic modifications: ${claudeError.message}`);
      
      // Apply the requested changes using Cheerio as fallback
      if (targetAction.type === 'color' || targetAction.type === 'colour') {
        if (targetAction.property === 'background-color' || targetAction.property === 'bg') {
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
      modifiedElementHtml = $.html($targetElement);
    }
    
    console.log(`Modified element HTML: ${modifiedElementHtml.substring(0, 100)}...`);
    
    // Improved element replacement approach
    
    // 1. First try direct string replacement
    let updatedContent = content.replace(originalElementHtml, modifiedElementHtml);
    
    // 2. If direct replacement failed, try DOM replacement
    if (updatedContent === content) {
      console.log("Direct string replacement failed, trying DOM replacement");
      
      // Create a new DOM with the content
      const $dom = cheerio.load(content);
      
      // Find the element in the new DOM
      let $elementToReplace;
      
      // Try to find by similar text content
      const targetText = targetElement.text.trim();
      $elementToReplace = $dom(`*:contains("${targetText}")`).filter(function() {
        // Skip html, body, etc.
        if ($dom(this).is('html, body, head, script, style')) {
          return false;
        }
        
        // Check if text content matches
        const text = $dom(this).text().trim();
        return text.includes(targetText) || targetText.includes(text);
      });
      
      if ($elementToReplace.length > 1) {
        console.log(`Found ${$elementToReplace.length} potential elements to replace, narrowing down`);
        
        // Try to narrow down by element type
        const tagName = $targetElement.prop('tagName').toLowerCase();
        const narrowed = $elementToReplace.filter(function() {
          return $dom(this).prop('tagName').toLowerCase() === tagName;
        });
        
        if (narrowed.length > 0) {
          $elementToReplace = narrowed.first();
        } else {
          $elementToReplace = $elementToReplace.first();
        }
      } else if ($elementToReplace.length === 0) {
        console.warn("Could not find element to replace in the DOM");
        
        // 3. If DOM replacement failed, try using serialized HTML search
        // Look for a unique snippet of the original element
        const snippets = [];
        if (originalElementHtml.length > 30) {
          // Extract a few unique-looking snippets from the original element
          snippets.push(originalElementHtml.substring(0, 30));
          snippets.push(originalElementHtml.substring(Math.floor(originalElementHtml.length / 2), 
                                               Math.floor(originalElementHtml.length / 2) + 30));
          
          // Try to replace each snippet
          let replacementSucceeded = false;
          for (const snippet of snippets) {
            if (content.includes(snippet)) {
              const escapedSnippet = snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const regexPattern = new RegExp(`[\\s\\S]*?(${escapedSnippet}[\\s\\S]*?)(?=<\\/${$targetElement.prop('tagName').toLowerCase()}>)`, 'i');
              const match = content.match(regexPattern);
              
              if (match && match[1]) {
                const fullMatch = match[1] + `</${$targetElement.prop('tagName').toLowerCase()}>`;
                updatedContent = content.replace(fullMatch, modifiedElementHtml);
                if (updatedContent !== content) {
                  console.log("Successfully replaced element using snippet match");
                  replacementSucceeded = true;
                  break;
                }
              }
            }
          }
          
          if (!replacementSucceeded) {
            console.error("All replacement attempts failed");
            return {
              success: false,
              message: "Could not reliably update the element in the document"
            };
          }
        }
      } else {
        // Replace the found element with the modified version
        console.log("Replacing element in DOM");
        $elementToReplace.replaceWith(modifiedElementHtml);
        updatedContent = $dom.html();
      }
    }
    
    // Write the updated content back to the file
    await fs.writeFile(filePath, updatedContent, 'utf-8');
    
    // Restart the server
    await restartServer(baseDir);
    
    return { 
      success: true, 
      message: `Successfully updated ${targetElement.type || 'element'} with text "${targetElement.text}" in ${file} using Claude design`,
      serverUrl: `http://localhost:3030/scraped_website/`,
      update: {
        elementType: targetElement.type || 'element',
        identifier: targetElement.text,
        change: `Claude-designed update based on: "${instruction}"`
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
