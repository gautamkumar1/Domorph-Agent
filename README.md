# Domorph Agent - Website Scraper and Editor

An intelligent agent powered by Claude that can scrape websites and edit their HTML content.

## Features

- Scrape any website and host it locally
- Update HTML content in scraped websites with simple text commands
- Chat with an AI assistant for help with web tasks

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

## How It Works

### System Components

1. **Agent (agent.js)**: The AI assistant that processes user messages and calls the appropriate tools
2. **Tools (tools.js)**: Functions for scraping websites and editing HTML content
3. **Routes (route.js)**: API endpoints for interacting with the agent
4. **System Prompt (system-prompt.js)**: Instructions for the AI assistant

### Workflow

1. User sends a message to the `/chat` endpoint
2. The message is processed to detect commands (URLs or HTML update commands)
3. The agent processes the message and calls the appropriate tools
4. The results are returned to the user

### Console Logging

The system includes extensive console logging to track:
- Incoming user messages
- Tool execution
- Website scraping progress
- HTML updates
- Server status

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