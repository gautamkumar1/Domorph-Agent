import fs from "fs/promises";
import path from "path";
import * as cheerio from 'cheerio';
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Transform HTML using Claude's capabilities
 * 
 * @param {string} html - The HTML to transform (can be a full page or single element)
 * @param {string} instruction - Natural language instruction describing the desired changes
 * @param {string} transformationType - Type of transformation: 'full-page', 'batch-elements', 'single-element', or 'auto'
 * @returns {Promise<string>} - The transformed HTML
 */
export async function transformHtml(html, instruction, transformationType = 'auto') {
  console.log(`🔄 HTML Transformer - Type: ${transformationType}, Instruction: "${instruction}"`);
  
  // Get Anthropic API key
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  
  // If no API key is available, fall back to basic transformations
  if (!anthropicKey) {
    console.log("⚠️ No ANTHROPIC_API_KEY found, falling back to basic HTML transformations");
    return basicHtmlTransform(html, instruction);
  }
  
  // Determine the transformation type if set to auto
  if (transformationType === 'auto') {
    transformationType = determineTransformationType(instruction, html);
    console.log(`Auto-detected transformation type: ${transformationType}`);
  }
  
  // Build appropriate prompt based on transformation type
  const { promptParts, systemPrompt } = buildPrompt(transformationType, html, instruction);
  
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
    modifiedHtml = cleanupClaudeResponse(modifiedHtml, transformationType);
    
    // Apply the transformation based on type
    if (transformationType === 'batch-elements') {
      return processBatchElementResult(modifiedHtml, html, instruction);
    } else {
      return modifiedHtml; // For full-page and single-element, return the cleaned result directly
    }
    
  } catch (error) {
    console.error(`❌ Error transforming HTML with Claude:`, error);
    // Fall back to basic transformations on error
    console.log("⚠️ Claude API error, falling back to basic HTML transformations");
    return basicHtmlTransform(html, instruction);
  }
}

/**
 * Basic HTML transform without Claude API
 * This function implements simple transformations based on the instruction
 */
async function basicHtmlTransform(html, instruction) {
  console.log(`🔧 Basic HTML Transform: "${instruction}"`);
  const $ = cheerio.load(html);
  
  // Parse the instruction to identify what needs to be changed
  const lowerInstruction = instruction.toLowerCase();
  
  // Check if this is a full-page redesign
  const isFullPageRedesign = lowerInstruction.includes('full page') || 
                             lowerInstruction.includes('entire page') || 
                             lowerInstruction.includes('whole page') || 
                             lowerInstruction.includes('complete redesign');
  
  // Check if this is a batch operation
  const isBatchOperation = lowerInstruction.match(/\b(all|every)\s+(\w+)s?\b/i);
  const batchElementType = isBatchOperation ? isBatchOperation[2].toLowerCase() : null;
  
  // Process based on operation type
  if (isFullPageRedesign) {
    // Full page redesign - add a comprehensive style tag
    const styleTag = `<style>
      /* Modern page design */
      body {
        font-family: 'Arial', sans-serif;
        line-height: 1.6;
        color: #333;
        margin: 0;
        padding: 0;
        background-color: #f8f9fa;
      }
      
      .container, main, .content {
        max-width: 1200px;
        margin: 0 auto;
        padding: 20px;
      }
      
      header {
        background-color: #0d6efd;
        color: white;
        padding: 20px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      }
      
      header nav {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      header a {
        color: white;
        text-decoration: none;
        margin: 0 10px;
      }
      
      footer {
        background-color: #212529;
        color: white;
        padding: 30px 20px;
        margin-top: 40px;
      }
      
      h1, h2, h3, h4, h5, h6 {
        font-weight: 600;
        line-height: 1.3;
      }
      
      a {
        color: #0d6efd;
        text-decoration: none;
        transition: color 0.3s;
      }
      
      a:hover {
        color: #0a58ca;
      }
      
      button, .btn, .button {
        background-color: #0d6efd;
        color: white;
        border: none;
        padding: 10px 20px;
        border-radius: 5px;
        cursor: pointer;
        transition: background-color 0.3s;
      }
      
      button:hover, .btn:hover, .button:hover {
        background-color: #0a58ca;
      }
      
      img {
        max-width: 100%;
        height: auto;
      }
      
      section {
        margin: 40px 0;
      }
      
      input, textarea, select {
        width: 100%;
        padding: 10px;
        margin-bottom: 15px;
        border: 1px solid #ced4da;
        border-radius: 4px;
      }
      
      @media (max-width: 768px) {
        .container {
          padding: 10px;
        }
      }
    </style>`;
    
    // Add the style tag to the head
    const head = $('head');
    if (head.length > 0) {
      head.append(styleTag);
    } else {
      $('html').prepend(`<head>${styleTag}</head>`);
    }
    
    // If the instruction mentions specific colors, update them
    if (lowerInstruction.includes('blue')) {
      $('header').css('background-color', '#0d6efd');
      $('button, .btn, .button').css('background-color', '#0d6efd');
      $('a').css('color', '#0d6efd');
    } else if (lowerInstruction.includes('green')) {
      $('header').css('background-color', '#198754');
      $('button, .btn, .button').css('background-color', '#198754');
      $('a').css('color', '#198754');
    } else if (lowerInstruction.includes('red')) {
      $('header').css('background-color', '#dc3545');
      $('button, .btn, .button').css('background-color', '#dc3545');
      $('a').css('color', '#dc3545');
    } else if (lowerInstruction.includes('dark')) {
      $('header').css('background-color', '#212529');
      $('body').css('background-color', '#343a40');
      $('body').css('color', '#e9ecef');
      $('.container, main, .content').css('background-color', '#495057');
      $('.container, main, .content').css('padding', '20px');
      $('.container, main, .content').css('border-radius', '5px');
    }
    
    // Add some flexbox containers if the instruction mentions "modern" or "responsive"
    if (lowerInstruction.includes('modern') || lowerInstruction.includes('responsive')) {
      $('section, .row, .container').each(function() {
        const $this = $(this);
        if ($this.children().length > 1) {
          $this.css({
            'display': 'flex',
            'flex-wrap': 'wrap',
            'gap': '20px',
            'justify-content': 'space-between'
          });
          
          $this.children().each(function() {
            $(this).css({
              'flex': '1 1 300px',
              'margin-bottom': '20px'
            });
          });
        }
      });
    }
  }
  
  // Batch operations - apply to all elements of a specific type
  else if (isBatchOperation) {
    const elementType = batchElementType;
    console.log(`Applying batch operation to all ${elementType} elements`);
    
    // Map element type to selector
    let selector;
    switch (elementType) {
      case 'button':
        selector = 'button, .btn, .button, a[role="button"], input[type="button"]';
        break;
      case 'link':
        selector = 'a';
        break;
      case 'heading':
        selector = 'h1, h2, h3, h4, h5, h6';
        break;
      case 'paragraph':
        selector = 'p';
        break;
      case 'image':
        selector = 'img';
        break;
      case 'section':
        selector = 'section, .section, article';
        break;
      case 'input':
        selector = 'input, textarea, select';
        break;
      default:
        selector = elementType; // Use element type directly as selector
    }
    
    // Apply styles based on instruction
    if (lowerInstruction.includes('blue')) {
      if (lowerInstruction.includes('background')) {
        $(selector).css('background-color', '#0d6efd');
        if (lowerInstruction.includes('text') || lowerInstruction.includes('color')) {
          $(selector).css('color', 'white');
        }
      } else if (lowerInstruction.includes('text') || lowerInstruction.includes('color')) {
        $(selector).css('color', '#0d6efd');
      }
    } 
    else if (lowerInstruction.includes('green')) {
      if (lowerInstruction.includes('background')) {
        $(selector).css('background-color', '#198754');
        if (lowerInstruction.includes('text') || lowerInstruction.includes('color')) {
          $(selector).css('color', 'white');
        }
      } else if (lowerInstruction.includes('text') || lowerInstruction.includes('color')) {
        $(selector).css('color', '#198754');
      }
    }
    else if (lowerInstruction.includes('red')) {
      if (lowerInstruction.includes('background')) {
        $(selector).css('background-color', '#dc3545');
        if (lowerInstruction.includes('text') || lowerInstruction.includes('color')) {
          $(selector).css('color', 'white');
        }
      } else if (lowerInstruction.includes('text') || lowerInstruction.includes('color')) {
        $(selector).css('color', '#dc3545');
      }
    }
    
    // Handle size changes
    if (lowerInstruction.includes('bigger') || lowerInstruction.includes('larger')) {
      if (elementType === 'button') {
        $(selector).css({
          'padding': '12px 25px',
          'font-size': '18px'
        });
      } else if (elementType === 'heading' || elementType === 'paragraph' || elementType === 'text') {
        $(selector).css('font-size', '120%');
      } else if (elementType === 'image') {
        $(selector).css({
          'max-width': '100%',
          'width': 'auto',
          'height': 'auto'
        });
      }
    }
    else if (lowerInstruction.includes('smaller')) {
      if (elementType === 'button') {
        $(selector).css({
          'padding': '5px 10px',
          'font-size': '14px'
        });
      } else if (elementType === 'heading' || elementType === 'paragraph' || elementType === 'text') {
        $(selector).css('font-size', '90%');
      }
    }
    
    // Handle rounded/circular
    if (lowerInstruction.includes('round') || lowerInstruction.includes('circular')) {
      if (elementType === 'button') {
        $(selector).css('border-radius', '50px');
      } else if (elementType === 'image') {
        $(selector).css('border-radius', '50%');
      } else {
        $(selector).css('border-radius', '10px');
      }
    }
    
    // Handle modern styling
    if (lowerInstruction.includes('modern')) {
      if (elementType === 'button') {
        $(selector).css({
          'box-shadow': '0 4px 6px rgba(0,0,0,0.1)',
          'transition': 'all 0.3s ease',
          'border': 'none'
        });
      } else if (elementType === 'input') {
        $(selector).css({
          'border': '1px solid #ced4da',
          'padding': '10px 15px',
          'border-radius': '5px',
          'transition': 'border-color 0.3s ease, box-shadow 0.3s ease'
        });
      } else if (elementType === 'section') {
        $(selector).css({
          'margin': '30px 0',
          'padding': '20px',
          'border-radius': '5px',
          'background-color': 'white',
          'box-shadow': '0 2px 4px rgba(0,0,0,0.05)'
        });
      }
    }
  }
  
  // Specific element transformations
  else {
    // Change background color
    if (lowerInstruction.includes('background') && 
        (lowerInstruction.includes('blue') || lowerInstruction.includes('red') || 
         lowerInstruction.includes('green') || lowerInstruction.includes('yellow'))) {
      // Extract the color
      let color = '';
      if (lowerInstruction.includes('blue')) color = '#0d6efd';
      else if (lowerInstruction.includes('red')) color = '#dc3545';
      else if (lowerInstruction.includes('green')) color = '#198754';
      else if (lowerInstruction.includes('yellow')) color = '#ffc107';
      
      // Target element
      let targetSelector = 'header';
      if (lowerInstruction.includes('header')) targetSelector = 'header';
      else if (lowerInstruction.includes('footer')) targetSelector = 'footer';
      else if (lowerInstruction.includes('button')) targetSelector = 'button, .btn, .button';
      else if (lowerInstruction.includes('nav')) targetSelector = 'nav, .nav, .navbar';
      else if (lowerInstruction.includes('section')) targetSelector = 'section, .section';
      
      // Apply the style
      $(targetSelector).css('background-color', color);
      
      // If "modern" is in the instruction, add some additional styling
      if (lowerInstruction.includes('modern')) {
        $(targetSelector).css('padding', '20px');
        $(targetSelector).css('border-radius', '5px');
        $(targetSelector).css('box-shadow', '0 4px 6px rgba(0,0,0,0.1)');
      }
    }
    
    // Change text color
    else if ((lowerInstruction.includes('color') || lowerInstruction.includes('text')) && 
             (lowerInstruction.includes('blue') || lowerInstruction.includes('red') || 
              lowerInstruction.includes('green') || lowerInstruction.includes('yellow'))) {
      // Extract the color
      let color = '';
      if (lowerInstruction.includes('blue')) color = '#0d6efd';
      else if (lowerInstruction.includes('red')) color = '#dc3545';
      else if (lowerInstruction.includes('green')) color = '#198754';
      else if (lowerInstruction.includes('yellow')) color = '#ffc107';
      
      // Target element
      let targetSelector = 'h1, h2, h3';
      if (lowerInstruction.includes('header')) targetSelector = 'header';
      else if (lowerInstruction.includes('footer')) targetSelector = 'footer';
      else if (lowerInstruction.includes('button')) targetSelector = 'button, .btn, .button';
      else if (lowerInstruction.includes('paragraph')) targetSelector = 'p';
      else if (lowerInstruction.includes('heading')) targetSelector = 'h1, h2, h3, h4, h5, h6';
      else if (lowerInstruction.includes('link')) targetSelector = 'a';
      
      // Apply the style
      $(targetSelector).css('color', color);
    }
    
    // Make buttons rounded
    else if (lowerInstruction.includes('button') && 
             (lowerInstruction.includes('round') || lowerInstruction.includes('circular'))) {
      $('button, .btn, .button').css('border-radius', '50px');
      $('button, .btn, .button').css('padding', '10px 20px');
    }
    
    // Make buttons bigger
    else if (lowerInstruction.includes('button') && 
             (lowerInstruction.includes('big') || lowerInstruction.includes('large'))) {
      $('button, .btn, .button').css('padding', '15px 30px');
      $('button, .btn, .button').css('font-size', '18px');
    }
    
    // Make header modern
    else if (lowerInstruction.includes('header') && lowerInstruction.includes('modern')) {
      $('header').css({
        'padding': '20px',
        'background-color': '#0d6efd',
        'color': 'white',
        'box-shadow': '0 2px 4px rgba(0,0,0,0.1)',
        'display': 'flex',
        'justify-content': 'space-between',
        'align-items': 'center'
      });
      
      // Style any navigation in the header
      $('header nav, header .nav, header ul').css({
        'display': 'flex',
        'gap': '20px',
        'list-style': 'none',
        'margin': '0',
        'padding': '0'
      });
      
      // Style links in header
      $('header a').css({
        'color': 'white',
        'text-decoration': 'none',
        'transition': 'opacity 0.3s'
      });
    }
    
    // Style all links
    else if (lowerInstruction.includes('link') && 
             (lowerInstruction.includes('style') || lowerInstruction.includes('all'))) {
      $('a').css({
        'color': '#0d6efd',
        'text-decoration': 'none',
        'transition': 'color 0.3s ease'
      });
      
      // Add hover style with a style tag
      const styleTag = `<style>
        a:hover { color: #0a58ca; text-decoration: underline; }
      </style>`;
      
      const head = $('head');
      if (head.length > 0) {
        head.append(styleTag);
      } else {
        $('html').prepend(`<head>${styleTag}</head>`);
      }
    }
    
    // Make footer responsive/modern
    else if (lowerInstruction.includes('footer') && 
             (lowerInstruction.includes('modern') || lowerInstruction.includes('responsive'))) {
      $('footer').css({
        'background-color': '#212529',
        'color': 'white',
        'padding': '40px 20px',
        'margin-top': '40px'
      });
      
      // Style any content in the footer to be responsive
      $('footer > div, footer > section').css({
        'display': 'flex',
        'flex-wrap': 'wrap',
        'gap': '30px',
        'justify-content': 'space-between'
      });
      
      $('footer > div > *, footer > section > *').css({
        'flex': '1 1 200px'
      });
      
      // Style links in footer
      $('footer a').css({
        'color': '#f8f9fa',
        'text-decoration': 'none',
        'transition': 'opacity 0.3s'
      });
    }
    
    // Make images responsive
    else if (lowerInstruction.includes('image') && 
             (lowerInstruction.includes('responsive') || lowerInstruction.includes('modern'))) {
      $('img').css({
        'max-width': '100%',
        'height': 'auto',
        'display': 'block'
      });
      
      if (lowerInstruction.includes('rounded') || lowerInstruction.includes('round')) {
        $('img').css('border-radius', '10px');
      }
      
      if (lowerInstruction.includes('shadow')) {
        $('img').css('box-shadow', '0 4px 8px rgba(0,0,0,0.1)');
      }
    }
    
    // Fall back to a very simple default transformation
    else {
      // Just add a style tag with some basic improvements
      const styleTag = `<style>
        body { font-family: 'Arial', sans-serif; line-height: 1.6; }
        button, .btn, .button { padding: 10px 20px; border-radius: 5px; background-color: #0d6efd; color: white; border: none; cursor: pointer; }
        a { color: #0d6efd; text-decoration: none; }
        header { padding: 15px; background-color: #f8f9fa; }
        footer { padding: 15px; background-color: #f8f9fa; margin-top: 20px; }
        img { max-width: 100%; height: auto; }
        input, textarea, select { padding: 8px; border: 1px solid #ced4da; border-radius: 4px; }
      </style>`;
      
      const head = $('head');
      if (head.length > 0) {
        head.append(styleTag);
      } else {
        $('html').prepend(`<head>${styleTag}</head>`);
      }
    }
  }
  
  return $.html();
}

/**
 * Determine the type of transformation needed based on instruction and HTML
 */
function determineTransformationType(instruction, html) {
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
      return 'full-page';
    }
  }
  
  // Check for batch operations with "all" pattern
  const allPattern = /\b(all|every)\s+(\w+)s?\b/i;
  if (allPattern.test(instruction)) {
    return 'batch-elements';
  }
  
  // Check if HTML appears to be a full page
  if (html.includes('<!DOCTYPE html>') || html.includes('<html') || html.includes('<body')) {
    const $ = cheerio.load(html);
    const allElements = $('*');
    
    // If it has a substantial DOM tree, treat as full page
    if (allElements.length > 100) {
      return 'full-page';
    }
  }
  
  // Default to single element for small HTML fragments
  return 'single-element';
}

/**
 * Build the appropriate prompt for Claude based on transformation type
 */
function buildPrompt(transformationType, html, instruction) {
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
  
  return { promptParts, systemPrompt };
}

/**
 * Clean up Claude's response based on transformation type
 */
function cleanupClaudeResponse(response, transformationType) {
  // Remove markdown code blocks
  let cleanedResponse = response.replace(/```(?:html|css)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  
  // Additional cleanup based on transformation type
  if (transformationType === 'full-page') {
    // Ensure we have a proper HTML document
    if (!cleanedResponse.includes('<!DOCTYPE html>') && 
        !cleanedResponse.startsWith('<html') && 
        !cleanedResponse.startsWith('<head')) {
      
      console.warn("Claude's response doesn't look like a full HTML page:", cleanedResponse.substring(0, 100));
      
      // Try to extract HTML if it's embedded in an explanation
      const htmlMatch = cleanedResponse.match(/<html[\s\S]*<\/html>/i);
      if (htmlMatch) {
        cleanedResponse = htmlMatch[0];
      } else {
        throw new Error("Invalid full page HTML response from Claude");
      }
    }
  } 
  else if (transformationType === 'single-element') {
    // Ensure we have an HTML element
    if (!cleanedResponse.startsWith('<')) {
      console.warn("Claude's response doesn't look like an HTML element:", cleanedResponse.substring(0, 100));
      
      // Try to extract HTML from response if present
      const htmlMatch = cleanedResponse.match(/<[^>]+>[\s\S]*<\/[^>]+>/);
      if (htmlMatch) {
        cleanedResponse = htmlMatch[0];
      } else {
        throw new Error("Invalid HTML element response from Claude");
      }
    }
  }
  
  return cleanedResponse;
}

/**
 * Process batch element result to apply changes to original HTML
 */
function processBatchElementResult(batchResult, originalHtml, instruction) {
  // Extract the style tag
  const styleMatch = batchResult.match(/<style>([\s\S]*?)<\/style>/);
  const cssRules = styleMatch ? styleMatch[1].trim() : null;
  
  // Extract the example element
  const elementMatch = batchResult.match(/<!--[\s\S]*?-->\s*(<[\s\S]*>)/);
  const elementExample = elementMatch ? elementMatch[1].trim() : null;
  
  if (!cssRules && !elementExample) {
    throw new Error("Claude did not return valid CSS or HTML example for batch operation");
  }
  
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
  const $ = cheerio.load(originalHtml);
  
  // Add CSS rules if present
  if (cssRules) {
    console.log(`Adding CSS rules to the document`);
    
    // Clean up CSS rules to avoid any issues with utility classes
    const cleanCssRules = cssRules
      .replace(/:[a-z]+-[0-9]+/g, '') // Remove things like :p-8, :text-lg
      .replace(/\.[mp][trblxy]?-\d+/g, '') // Remove utility margin/padding classes
      .replace(/\.text-\w+/g, '') // Remove text utility classes
      .replace(/\.bg-\w+/g, '') // Remove background utility classes
      .replace(/\.flex-\w+/g, ''); // Remove flex utility classes
    
    const styleTag = `<style>${cleanCssRules}</style>`;
    
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
    
    try {
      // Parse the example
      const $example = cheerio.load(elementExample);
      const exampleEl = $example.root().children().first();
      
      // Apply to all matching elements
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
          
          // If the instruction mentions text or content, update the inner HTML
          if ((instruction.includes('text') || instruction.includes('content')) && 
              exampleEl.html() !== $el.html()) {
            $el.html(exampleEl.html());
          }
          
          updateCount++;
        });
        
        console.log(`Updated ${updateCount} elements matching selector: ${selector}`);
      } catch (error) {
        console.warn(`Error applying changes to selector "${selector}": ${error.message}`);
      }
    } catch (error) {
      console.error(`Error processing example element: ${error.message}`);
    }
  }
  
  return $.html();
}

/**
 * Transform an HTML file with Claude
 * 
 * @param {string} filePath - Path to the HTML file
 * @param {string} instruction - Natural language instruction
 * @returns {Promise<object>} - Result object with success status and message
 */
export async function transformHtmlFile(filePath, instruction) {
  try {
    console.log(`🔄 Transforming HTML file: ${filePath}`);
    
    // Read the file
    const content = await fs.readFile(filePath, 'utf-8');
    console.log(`Read file content (${content.length} chars)`);
    
    // Determine the transformation type
    const transformationType = determineTransformationType(instruction, content);
    console.log(`Transformation type: ${transformationType}`);
    
    // Transform the HTML
    const transformedHtml = await transformHtml(content, instruction, transformationType);
    
    // Write the transformed HTML back to the file
    await fs.writeFile(filePath, transformedHtml, 'utf-8');
    
    return {
      success: true,
      message: `Successfully transformed ${filePath}`,
      transformationType
    };
  } catch (error) {
    console.error(`Error transforming HTML file: ${error.message}`);
    return {
      success: false,
      message: `Error transforming HTML file: ${error.message}`
    };
  }
}

/**
 * Find the most relevant element based on instruction
 * 
 * @param {string} html - HTML content
 * @param {string} instruction - Natural language instruction
 * @returns {object} - Object with element and its HTML
 */
export async function findRelevantElement(html, instruction) {
  const $ = cheerio.load(html);
  
  // Extract key terms from instruction
  const words = instruction.toLowerCase().split(/\s+/);
  const keyTerms = words.filter(word => word.length > 3 && !['make', 'change', 'update', 'modify', 'with', 'from', 'into', 'that', 'this', 'these', 'those'].includes(word));
  
  // Scoring function for elements
  function scoreElement($el) {
    let score = 0;
    
    // Check element text for key terms
    const text = $el.text().toLowerCase();
    keyTerms.forEach(term => {
      if (text.includes(term)) score += 3;
    });
    
    // Check attributes for key terms
    const attrs = $el.attr() || {};
    Object.values(attrs).forEach(value => {
      if (typeof value === 'string') {
        keyTerms.forEach(term => {
          if (value.toLowerCase().includes(term)) score += 2;
        });
      }
    });
    
    // Score different element types
    if ($el.is('button')) score += 5;
    if ($el.is('a')) score += 4;
    if ($el.is('div.button, span.button, a.button, .btn')) score += 4;
    if ($el.is('h1, h2, h3')) score += 3;
    if ($el.is('p')) score += 2;
    if ($el.is('img')) score += 2;
    
    return score;
  }
  
  // Find all potential elements
  const candidates = [];
  $('*').each((i, el) => {
    const $el = $(el);
    
    // Skip some elements
    if ($el.is('html, body, head, script, style, meta, link')) return;
    
    const score = scoreElement($el);
    if (score > 0) {
      candidates.push({
        element: el,
        score: score,
        html: $.html(el)
      });
    }
  });
  
  // Sort by score
  candidates.sort((a, b) => b.score - a.score);
  
  if (candidates.length > 0) {
    return {
      element: candidates[0].element,
      html: candidates[0].html,
      score: candidates[0].score
    };
  }
  
  throw new Error("No relevant element found for the instruction");
}

/**
 * Export the functions needed by other files
 */
export default {
  transformHtml,
  transformHtmlFile,
  findRelevantElement
}; 