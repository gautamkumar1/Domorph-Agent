# Domorph-Agent: Intelligent HTML Update System

Domorph-Agent is a powerful tool for scraping websites and making precise modifications to the HTML content using natural language instructions.

## Features

- **Website Scraping**: Scrape any website and host it locally
- **Intelligent HTML Updates**: Modify HTML elements using natural language instructions
- **Precise Element Targeting**: Find and modify specific elements like buttons by their text content

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

Use this format for more complex, targeted modifications:

```
@filename.html instruction
```

Where "instruction" is a natural language description of the change.

Examples:
```
@index.html make the Contact button color red
@index.html changed the Fetch Subscription button colour to white
@index.html set the header background color to blue
@index.html change the Submit button text to "Send Now"
```

## How It Works

The intelligent HTML update system works in the following way:

1. **Parsing**: The system parses your natural language instruction to extract:
   - The target element (e.g., "Contact button", "Fetch Subscription button")
   - The modification to apply (e.g., "color red", "colour white")

2. **Element Targeting**: The system uses Cheerio to find the exact element in the HTML:
   - First tries exact text matching
   - Falls back to partial text matching
   - Also checks elements that might be styled as buttons (links, divs with button classes)

3. **Modification**: The appropriate change is applied to the targeted element:
   - Color changes (text or background)
   - Style modifications
   - Text content updates
   - Class or attribute changes

4. **Verification**: The system verifies that changes were made:
   - Using diff-match-patch to detect differences
   - Falls back to direct element replacement if needed

5. **Fallback**: If the element can't be found using Cheerio, the system falls back to an LLM-based approach that:
   - Uses Claude to find the relevant HTML snippet
   - Uses Claude to update that snippet
   - Replaces the snippet in the original HTML

## Technical Implementation

The system uses several key libraries:

- **Cheerio**: jQuery-like HTML parsing and manipulation
  - Used for precise element selection and modification
  - Ideal for basic HTML element edits

- **diff-match-patch**: Text diffing and patching
  - Used to verify changes and ensure minimal modifications
  - Helps track changes between original and modified HTML

- **Claude (Anthropic)**: AI-powered HTML analysis
  - Used as a fallback for complex scenarios
  - Helps identify relevant HTML snippets when direct targeting fails

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