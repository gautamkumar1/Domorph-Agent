# Domorph Agent - HTML Transformer

A powerful tool for transforming HTML pages with natural language instructions, using both Claude AI and advanced CSS manipulation techniques.

## Features

- **Intelligent HTML Transformation**: Update HTML elements or entire pages using natural language instructions
- **Multiple Operation Types**:
  - Single element modifications (e.g., "make the header blue")
  - Batch operations on multiple elements (e.g., "make all buttons rounded")
  - Full page redesigns (e.g., "redesign the entire page with a modern look")
- **Support for Claude AI**: Enhanced transformations using Claude 3.7 Sonnet when API key is available
- **Fallback Implementation**: Basic transformations still work without Claude API

## Transformation Capabilities

The HTML transformer can handle various types of transformations:

### Single Element Modifications
- Change background colors
- Change text colors
- Modify styles (padding, margins, borders, etc.)
- Make elements rounded or circular
- Change sizes (make bigger/smaller)
- Apply modern styling (shadows, transitions, etc.)

### Batch Operations
- Apply transformations to all elements of a specific type
- Support for various element types: buttons, links, headings, paragraphs, images, sections, inputs, etc.
- Apply consistent styling across multiple elements

### Full Page Redesigns
- Apply comprehensive styling to the entire page
- Make pages responsive with flexbox layouts
- Modern typography and spacing
- Consistent color schemes

## Usage

```javascript
import { intelligentHtmlUpdate } from './tools.js';

// Update a single element
await intelligentHtmlUpdate('/index.html', 'make the header background blue and modern');

// Batch operation
await intelligentHtmlUpdate('/index.html', 'make all buttons rounded and blue');

// Full page redesign
await intelligentHtmlUpdate('/index.html', 'redesign the full page with a modern and clean look');
```

## Environment Variables

- `ANTHROPIC_API_KEY`: (Optional) Set this to use Claude AI for enhanced transformations

## How It Works

1. The tool parses the natural language instruction to determine the operation type
2. If Claude API is available, it uses the AI to generate optimal HTML/CSS transformations
3. If Claude API is not available, it falls back to a rule-based implementation that handles common transformations
4. For batch operations, it uses CSS selectors to identify and modify groups of elements
5. For full page redesigns, it applies comprehensive styling to create a modern, responsive design

## Future Enhancements

- Support for more complex transformations
- Enhanced element targeting for more specific modifications
- Animation and transition effects
- Support for theme-based redesigns

## Natural Language Capabilities

Domorph-Agent now supports v0-like natural language commands for modifying web pages. You can describe what you want to change in plain English, and the system will:

1. Break the HTML into semantic chunks (navigation, main content, buttons, etc.)
2. Identify the most relevant parts of the page for your request
3. Send only the necessary context to Claude
4. Apply the modifications precisely where needed

### Examples of Natural Language Commands

```
@index.html make the Contact button color red
@about.html change the main heading to "Our Amazing Team"
@products.html update the pricing from $99 to $89
@talk.html make the Send button background white and text black
@index.html change all buttons to have rounded corners and blue background
@contact.html redesign the entire page with a modern dark theme
```

The system handles these commands by:
- Breaking the page into semantic chunks
- Prioritizing chunks that contain elements matching keywords in your instruction
- Sending Claude only the most relevant parts of the HTML to stay within context limits
- Using several matching strategies to find the right elements to update

## HTML Update Commands

There are three main types of updates you can perform:

### 1. Simple Text Replacement

Use this format for direct text replacement:

```
@filename.html changed text to newtext
```

Example:
```
@index.html changed Gautam to Amit
```

This will replace all occurrences of "Gautam" with "Amit" in the index.html file.

### 2. Targeted Element Updates

For precise updates to specific elements:

```
@filename.html instruction about what to change
```

Examples:
```
@index.html change the Send button background to blue
@about.html make the header text larger and bold
@contact.html update the email address to contact@example.com
```

### 3. Batch Element Updates

To update multiple elements of the same type at once:

```
@filename.html change all [element type] to [desired changes]
```

Examples:
```
@index.html make all buttons red with white text
@about.html change all headings to uppercase and dark blue
@products.html make all images have rounded corners and borders
```

### 4. Full Page Redesigns

To completely transform an entire page:

```
@filename.html redesign the entire page [with additional instructions]
```

Examples:
```
@index.html redesign the entire page with a dark modern theme
@about.html completely redesign the page to be more professional and corporate
@landing.html redesign the whole page with a minimalist aesthetic
```

## How It Works

### Targeted Element Updates
The system identifies specific elements by:
1. Parsing your instruction
2. Identifying the target element
3. Generating the appropriate HTML changes
4. Applying them precisely

### Batch Operations
For updating multiple elements at once:
1. Uses advanced selector patterns to identify groups of elements (like "all buttons")
2. Extracts sample elements to send to Claude
3. Generates both CSS rules and HTML modifications
4. Applies changes consistently across all matching elements

### Full Page Redesigns
For complete page transformations:
1. Detects "redesign" intent in your instructions
2. Sends the entire page HTML to Claude with specific redesign guidelines
3. Applies comprehensive visual changes while preserving functionality
4. Maintains all original content, IDs, and core structure

## How Context Management Works

When dealing with large HTML files, the system:

1. **Chunks the HTML**: Breaks the HTML into semantic sections like navigation, main content, buttons, etc.
2. **Prioritizes chunks**: Assigns importance scores based on relevance to your instruction
3. **Builds a smart prompt**: Includes only the most relevant chunks to stay within Claude's context window
4. **Preserves structure**: Maintains document metadata and relationship between elements

This approach allows for modifications to even very large HTML files that would otherwise exceed Claude's context limits.

## API

### `intelligentHtmlUpdate(file, instruction)`

Updates HTML content based on natural language instructions.

Parameters:
- `file`: Path to the HTML file within scraped_website folder
- `instruction`: Natural language instruction describing what to change

Returns:
- Object with success status, message, and server URL

Example:
```javascript
const result = await intelligentHtmlUpdate('index.html', 'change the Get Started button color to blue');
```

## Setup

1. Clone the repository
2. Run `npm install` to install dependencies
3. Set your Anthropic API key in the environment variable: `ANTHROPIC_API_KEY`
4. Start the application
5. Use the commands described above to modify your HTML files

## Technical Implementation

The system uses several key libraries:

- **Cheerio**: jQuery-like HTML parsing and manipulation
  - Used for precise element selection and modification
  - Ideal for basic HTML element edits

- **diff-match-patch**: Text diffing and patching
  - Used to verify changes and ensure minimal modifications
  - Helps track changes between original and modified HTML

- **Claude (Anthropic)**: AI-powered HTML analysis and design
  - Primary method for complex element redesign
  - Used to analyze HTML structure and apply changes intelligently
  - Maintains element functionality while improving appearance
  - Used as a fallback for element identification when Cheerio fails

## Advanced Design Capabilities

With the Claude-powered design feature, you can request more complex and nuanced changes:

- **Visual Styling**: "Make this button more prominent"
- **Aesthetic Improvements**: "Make this card more modern looking" 
- **Complex Color Changes**: "Change the button to a gradient from blue to purple"
- **Layout Adjustments**: "Make this menu more compact"
- **Responsive Design**: "Make this element mobile-friendly"

The system intelligently interprets your design intent and applies appropriate HTML/CSS modifications while preserving the element's functionality and existing attributes.

## Getting Started

1. Ensure you have Node.js installed
2. Install dependencies: `npm install`
3. Set your Anthropic API key: `export ANTHROPIC_API_KEY=your_key_here`
4. Run the server: `npm start`
5. Access the UI at http://localhost:3000

## Example Usage

1. Scrape a website:
   ```
   https://example.com
   ```

2. Update an element:
   ```
   @index.html changed the Fetch Subscription button colour to white
   ```

3. View the updated website at the provided link (usually http://localhost:3030/scraped_website/)

## Prerequisites

- Node.js (v14 or higher)
- Anthropic API key

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/domorph-agent.git
cd domorph-agent
```

2. Install dependencies:
```bash
npm install
```

3. Set your Anthropic API key as an environment variable:
```bash
export ANTHROPIC_API_KEY=your_api_key_here
```

## Running the Application

Start the server:
```bash
npm start
```

The server will start on port 3000 (or the port specified in your environment variables).

## Using the Agent

### API Endpoints

#### Chat with the Agent

```
POST /chat
```

Request body:
```json
{
  "message": "Your message here",
  "userId": "optional-user-id"
}
```

Response:
```json
{
  "response": "Agent's response",
  "threadId": "user-id"
}
```

#### Clear Chat History

```
POST /clear
```

Request body:
```json
{
  "userId": "user-id-to-clear"
}
```

### Features and Commands

#### Website Scraping

To scrape a website, simply send a chat message with a URL:

```json
{
  "message": "https://example.com"
}
```

The agent will:
1. Scrape the website
2. Save it to the `scraped_website` folder
3. Host it locally at `http://localhost:3030/scraped_website/`
4. Return the URL and information about the scraping results

#### HTML Content Updating

To update HTML content in a scraped website, use the following format:

```json
{
  "message": "@filename.html changed oldtext to newtext"
}
```

For example:
```json
{
  "message": "@index.html changed Gautam to Amit"
}
```

The agent will:
1. Find the file in the scraped_website folder
2. Replace all occurrences of "oldtext" with "newtext"
3. Restart the website server
4. Return information about the update

## Troubleshooting

**Issue**: Failed to scrape website
**Solution**: Check that the URL is valid and the website is accessible

**Issue**: HTML update failed
**Solution**: Ensure the file exists in the scraped_website folder and the text to replace exists in the file

**Issue**: Agent not responding
**Solution**: Check that your Anthropic API key is valid and properly set

## License

[MIT](LICENSE)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. 