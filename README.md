# Domorph Web Scraping Agent

A web scraping agent powered by LangGraph and Anthropic Claude that can scrape websites and interact with users through a web interface.

## Features

- Scrapes websites and extracts their content
- Powered by LangGraph and Anthropic's Claude model
- Maintains conversation history
- Provides a simple web interface for interaction

## Requirements

- Node.js 18 or newer
- Anthropic API key (Claude)
- Internet connection for web scraping

## Installation

1. Clone the repository:
```
git clone https://github.com/yourusername/domorph-agent.git
cd domorph-agent
```

2. Install dependencies:
```
npm install
```

## Usage

1. Start the server:
```
npm start
```

2. Open your browser and go to `http://localhost:3002`

3. Enter your Anthropic API key in the configuration section

4. Start chatting with the agent. You can:
   - Ask questions
   - Paste a website URL to scrape it
   - Interact with the scraped content

## API Endpoints

- `POST /api/agent/configure` - Configure the agent with API keys
- `POST /api/agent/chat` - Send a message to the agent
- `POST /api/agent/clear` - Clear a user's conversation thread
- `GET /api/agent/debug/threads` - Get debug information about active threads

## Project Structure

- `agent.js` - LangGraph agent implementation
- `tools.js` - Web scraping functionality
- `route.js` - API routes
- `index.js` - Express server setup
- `public/` - Static files and scraped website storage

## How It Works

1. The agent detects when a URL is entered in a message
2. It uses Puppeteer to scrape the website
3. The website content is saved locally in the `public/scraped_website` directory
4. The agent processes the content and can answer questions about it

## License

MIT 