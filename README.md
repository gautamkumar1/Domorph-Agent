# Domorph-Agent: Intelligent HTML Update System

Domorph-Agent is a powerful tool for scraping websites and making precise modifications to the HTML content using natural language instructions.

## Features

- **Website Scraping**: Scrape any website and host it locally
- **Intelligent HTML Updates**: Modify HTML elements using natural language instructions
- **Precise Element Targeting**: Find and modify specific elements like buttons by their text content
- **AI-Powered Design**: Uses Claude to intelligently redesign HTML elements based on natural language instructions
- **Smart Context Management**: Breaks large HTML files into semantic chunks to provide Claude with the most relevant context for modifications

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
```

The system handles these commands by:
- Breaking the page into semantic chunks
- Prioritizing chunks that contain elements matching keywords in your instruction
- Sending Claude only the most relevant parts of the HTML to stay within context limits
- Using several matching strategies to find the right elements to update

## HTML Update Commands

There are two ways to update HTML in the scraped website:

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

### 2. Intelligent Element Updates

For more precise updates to specific elements, use natural language:

```
@filename.html instruction about what to change
```

Examples:
```
@index.html change the Send button background to blue
@about.html make the header text larger and bold
@contact.html update the email address to contact@example.com
```

The system will:
1. Parse your instruction
2. Identify the target element
3. Generate the appropriate HTML changes
4. Apply them precisely

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