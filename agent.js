import { createReactAgent, ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { StateGraph,MessagesAnnotation } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph"; 
import { webScraping, updateHtml, intelligentHtmlUpdate } from "./tools.js";
import { systemPrompt } from "./system-prompt.js";

// Regex for parsing HTML update commands
const UPDATE_HTML_REGEX = /@(\S+\.html)\s+changed\s+(?:the\s+)?(.+?)\s+to\s+(.+?)(?:\s|$)/i;

// New regex for intelligent HTML updates
const INTELLIGENT_HTML_UPDATE_REGEX = /@(\S+\.html)\s+(.+)$/i;

// Function to parse HTML update commands from messages
function parseHtmlUpdateCommand(message) {
  if (typeof message !== 'string') return null;
  
  // Try the specific update command first
  const match = message.match(UPDATE_HTML_REGEX);
  if (match) {
    console.log("📝 Detected specific HTML update command in message");
    return {
      type: "simple",
      file: match[1],
      oldText: match[2],
      newText: match[3]
    };
  }
  
  // Then try the general instruction format
  const instructionMatch = message.match(INTELLIGENT_HTML_UPDATE_REGEX);
  if (instructionMatch) {
    console.log("🧠 Detected intelligent HTML update instruction");
    return {
      type: "intelligent",
      file: instructionMatch[1],
      instruction: instructionMatch[2]
    };
  }
  
  return null;
}

function getToolUseUrl(messages) {
  console.log("Trying to extract URL from messages, count:", messages.length);
  
  // First check if the latest message is an HTML update command
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    
    // Check if it's an HTML update message
    if (lastMsg instanceof HumanMessage && typeof lastMsg.content === "string") {
      const htmlUpdate = parseHtmlUpdateCommand(lastMsg.content);
      if (htmlUpdate) {
        console.log("📝 This is an HTML update command, not a URL for scraping");
        return null; // Don't treat HTML update commands as URLs
      }
    }
  }
  
  // First check the most recent message for direct URL mentions
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    
    // Check if the message has a content string with a URL
    if (typeof lastMsg.content === "string") {
      const urlPattern = /(https?:\/\/[^\s]+)/;
      const match = lastMsg.content.match(urlPattern);
      if (match && match[0]) {
        console.log("URL found in most recent message content:", match[0]);
        return match[0];
      }
    }
    
    // Check if the message has a content array with a text element containing a URL
    if (Array.isArray(lastMsg.content)) {
      for (const content of lastMsg.content) {
        if (content.type === "text" && typeof content.text === "string") {
          const urlPattern = /(https?:\/\/[^\s]+)/;
          const match = content.text.match(urlPattern);
          if (match && match[0]) {
            console.log("URL found in most recent message content array:", match[0]);
            return match[0];
          }
        }
      }
    }
  }
  
  // Then check all messages
  for (const msg of messages) {
    // Check for direct URL in HumanMessage content
    if (
      (msg.type === "constructor" && 
      msg.id?.includes("HumanMessage") && 
      typeof msg.kwargs?.content === "string" && 
      (msg.kwargs.content.includes("http://") || msg.kwargs.content.includes("https://")))
    ) {
      // Extract URL from content using regex
      const urlPattern = /(https?:\/\/[^\s]+)/;
      const match = msg.kwargs.content.match(urlPattern);
      if (match && match[0]) {
        console.log("URL found directly in HumanMessage:", match[0]);
        return match[0];
      }
    }
    
    // Check if it's a HumanMessage instance with URL content
    if (msg instanceof HumanMessage && 
        typeof msg.content === "string" && 
        (msg.content.includes("http://") || msg.content.includes("https://"))) {
      const urlPattern = /(https?:\/\/[^\s]+)/;
      const match = msg.content.match(urlPattern);
      if (match && match[0]) {
        console.log("URL found in HumanMessage instance:", match[0]);
        return match[0];
      }
    }

    // Check for tool_use format
    if (
      msg.type === "constructor" &&
      msg.id?.includes("AIMessage") &&
      Array.isArray(msg.kwargs?.content)
    ) {
      for (const content of msg.kwargs.content) {
        if (content.type === "tool_use" && content.input?.url) {
          console.log("Tool use URL found in constructor format:", content.input.url);
          return content.input.url;
        }
      }
    }
    
    // Check alternative format (directly in AIMessage content)
    if (msg instanceof AIMessage && Array.isArray(msg.content)) {
      for (const content of msg.content) {
        if (content.type === "tool_use" && content.input?.url) {
          console.log("Tool use URL found in AIMessage content:", content.input.url);
          return content.input.url;
        }
      }
    }
    
    // Additional format check (tool_calls property)
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const toolCall of msg.tool_calls) {
        if (toolCall.name === "scrape_website" && toolCall.args?.url) {
          console.log("Tool use URL found in tool_calls:", toolCall.args.url);
          return toolCall.args.url;
        }
      }
    }
    
    // Check for a URL in any generic object content
    if (typeof msg.content === "string" && 
        (msg.content.includes("http://") || msg.content.includes("https://"))) {
      const urlPattern = /(https?:\/\/[^\s]+)/;
      const match = msg.content.match(urlPattern);
      if (match && match[0]) {
        console.log("URL found in generic message content:", match[0]);
        return match[0];
      }
    }
  }
  
  console.log("No URL found in messages");
  return null; // if not found
}

// Create a tool that wraps the webScraping function
const websiteScraper = {
  name: "scrape_website",
  description: "Scrapes a website and extracts its content",
  schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL of the website to scrape",
      },
    },
    required: ["url"],
  },
  invoke: async (args) => {
    console.log(`🔍 Scraping website - received args:`, JSON.stringify(args));
    
    // Handle different input formats
    let url;
    
    if (typeof args === 'string') {
      // If args is a string, assume it's the URL
      url = args;
      console.log(`Received URL as direct string: ${url}`);
    } else if (args && typeof args === 'object') {
      // If args is an object, look for url property
      url = args.url;
      console.log(`Extracted URL from args object: ${url}`);
    } else {
      console.error(`Invalid args format:`, args);
      return { 
        message: "Invalid arguments. Expected a URL string or an object with a url property.",
        error: true 
      };
    }
    
    // Ensure URL is a string and properly formatted
    if (!url || typeof url !== 'string') {
      console.error("Invalid URL format received:", url);
      return { 
        message: "Invalid URL format. Please provide a valid URL string.",
        error: true 
      };
    }
    
    // Make sure URL has a protocol
    let formattedUrl = url;
    if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
      formattedUrl = 'https://' + formattedUrl;
      console.log(`Added protocol to URL: ${formattedUrl}`);
    }
    
    try {
      console.log(`Calling webScraping with URL: ${formattedUrl}`);
      const result = await webScraping(formattedUrl);
      console.log(`✅ Scraping completed: ${result.message}`);
      return {
        ...result,
        original_url: url,
        formatted_url: formattedUrl
      };
    } catch (error) {
      console.error(`❌ Error during web scraping:`, error);
      return { 
        message: `Scraping failed: ${error.message}`,
        error: true,
        original_url: url,
        formatted_url: formattedUrl
      };
    }
  },
};

// Create a tool that wraps the updateHtml function
const htmlUpdater = {
  name: "update_html",
  description: "Updates HTML content in the scraped website and restarts the server",
  schema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "The HTML file to update (relative to scraped_website folder)",
      },
      oldText: {
        type: "string",
        description: "The text to replace (only for simple updates)",
      },
      newText: {
        type: "string",
        description: "The new text to insert (only for simple updates)",
      },
      instruction: {
        type: "string",
        description: "Natural language instruction describing what to change (for intelligent updates)",
      },
      updateType: {
        type: "string",
        description: "The type of update: 'simple' or 'intelligent'",
      },
    },
    required: ["file", "updateType"],
  },
  invoke: async (args) => {
    console.log(`🔄 Updating HTML content - received args:`, JSON.stringify(args));
    
    let file, oldText, newText, instruction, updateType;
    
    if (typeof args === 'string') {
      // Try to parse from string using regex
      const parsed = parseHtmlUpdateCommand(args);
      if (parsed) {
        file = parsed.file;
        updateType = parsed.type;
        
        if (updateType === "simple") {
          oldText = parsed.oldText;
          newText = parsed.newText;
        } else if (updateType === "intelligent") {
          instruction = parsed.instruction;
        }
      } else {
        return { 
          success: false, 
          message: "Invalid string format." 
        };
      }
    } else if (args && typeof args === 'object') {
      // Extract from object
      file = args.file;
      oldText = args.oldText;
      newText = args.newText;
      instruction = args.instruction;
      updateType = args.updateType || (oldText && newText ? "simple" : "intelligent");
    } else {
      return { 
        success: false, 
        message: "Invalid arguments format." 
      };
    }
    
    // Validate parameters
    if (!file || !updateType) {
      return { 
        success: false, 
        message: "Missing required parameters: file and updateType must be provided." 
      };
    }
    
    if (updateType === "simple") {
      if (!oldText || !newText) {
        return { 
          success: false, 
          message: "For simple updates, oldText and newText must be provided." 
        };
      }
      
      console.log(`Calling updateHtml with: file=${file}, oldText=${oldText}, newText=${newText}`);
      return await updateHtml(file, oldText, newText);
    } else if (updateType === "intelligent") {
      if (!instruction) {
        return { 
          success: false, 
          message: "For intelligent updates, instruction must be provided." 
        };
      }
      
      console.log(`Calling intelligentHtmlUpdate with: file=${file}, instruction=${instruction}`);
      return await intelligentHtmlUpdate(file, instruction);
    } else {
      return { 
        success: false, 
        message: "Invalid updateType. Must be 'simple' or 'intelligent'." 
      };
    }
  },
};

// Create an Anthropic model
export const createAgent = (apiKey) => {
  if (!apiKey) {
    throw new Error("Anthropic API key is required");
  }

  console.log("Creating Anthropic-powered LangGraph agent...");
  
  // Initialize the model with Anthropic
  const model = new ChatAnthropic({
    apiKey,
    model: "claude-3-haiku-20240307",
    temperature: 0,
    systemPrompt
  });

  const tools = [websiteScraper, htmlUpdater];
  const toolNode = new ToolNode(tools);

  // Custom handler for tool execution that provides better debugging
  async function executeTools({ messages }) {
    const lastMessage = messages[messages.length - 1];
    console.log("Executing tools for message:", lastMessage.type || "unknown type");
    
    let toolCalls = [];
    
    // Check if the last message is a direct HTML update command
    if (lastMessage instanceof HumanMessage && typeof lastMessage.content === "string") {
      const htmlUpdate = parseHtmlUpdateCommand(lastMessage.content);
      if (htmlUpdate) {
        console.log("🔄 Detected HTML update command in executeTools:", htmlUpdate);
        toolCalls.push({
          name: "update_html",
          args: htmlUpdate,
          id: `tool-${Date.now()}`
        });
      }
    }
    
    // If no HTML update command was detected, extract tool calls as usual
    if (toolCalls.length === 0) {
      // Extract tool calls from standard format
      if (lastMessage.tool_calls && Array.isArray(lastMessage.tool_calls)) {
        toolCalls = lastMessage.tool_calls;
        console.log("Found standard tool_calls format", toolCalls.length);
      } 
      // Extract tool calls from content array format
      else if (Array.isArray(lastMessage.content)) {
        for (const content of lastMessage.content) {
          if (content.type === "tool_use") {
            toolCalls.push({
              name: content.tool_name,
              args: content.input,
              id: content.id || `tool-${Date.now()}`
            });
            console.log("Found tool_use in content array");
          }
        }
      }
    }
    
    if (toolCalls.length === 0) {
      console.error("No tool calls found in the message!");
      return { messages: [] };
    }
    
    const results = [];
    
    for (const toolCall of toolCalls) {
      console.log(`Processing tool call: ${toolCall.name}`, toolCall.args);
      
      // Find the matching tool
      const tool = tools.find((t) => t.name === toolCall.name);
      
      if (!tool) {
        console.error(`Tool not found: ${toolCall.name}`);
        continue;
      }
      
      try {
        // Special handling for the update_html tool
        if (toolCall.name === "update_html") {
          console.log("📄 Handling HTML update tool call with args:", toolCall.args);
          const result = await tool.invoke(toolCall.args);
          results.push({
            tool_call_id: toolCall.id,
            name: toolCall.name,
            result
          });
          continue;
        }
        
        // Process URL specifically for the scrape_website tool
        if (toolCall.name === "scrape_website") {
          // Get URL from args
          let url = toolCall.args?.url;
          
          // If no URL in args, try to extract it from message content
          if (!url) {
            url = getToolUseUrl(messages);
            console.log("URL extracted from messages:", url);
          }
          
          // If still no URL, check if there's a raw string URL in args
          if (!url && typeof toolCall.args === "string") {
            const urlMatch = toolCall.args.match(/(https?:\/\/[^\s]+)/);
            if (urlMatch) url = urlMatch[0];
            console.log("URL extracted from string args:", url);
          }
          
          // Use the URL
          if (url) {
            toolCall.args = { url };
          } else {
            console.error("Could not find a URL to use for scraping");
          }
        }
        
        console.log(`Invoking tool ${toolCall.name} with args:`, toolCall.args);
        const result = await tool.invoke(toolCall.args);
        
        results.push({
          tool_call_id: toolCall.id,
          name: toolCall.name,
          result
        });
      } catch (error) {
        console.error(`Error invoking tool ${toolCall.name}:`, error);
        results.push({
          tool_call_id: toolCall.id,
          name: toolCall.name,
          result: { error: error.message }
        });
      }
    }
    
    // Return results as tool result messages
    return {
      messages: results.map(result => ({
        type: "tool_result",
        tool_call_id: result.tool_call_id,
        name: result.name,
        content: result.result
      }))
    };
  }

  // Use the custom handler instead of the default ToolNode
  const customToolNode = {
    invoke: executeTools
  };

  // Bind tools to the model
  const modelWithTools = model.bindTools(tools);

  // Define the function that determines the next step
  function shouldContinue({ messages }) {
    const lastMessage = messages[messages.length - 1];

    // Debug the structure of the last message
    console.log("Last message structure:", JSON.stringify(lastMessage).substring(0, 500) + "...");

    // Check if this is an HTML update request
    if (lastMessage && lastMessage.content) {
      // If it's a human message, check if it's an HTML update command
      if (lastMessage.type === "human" && typeof lastMessage.content === "string") {
        const htmlUpdate = parseHtmlUpdateCommand(lastMessage.content);
        if (htmlUpdate) {
          console.log("👨‍💻 Detected HTML update request in user message");
          // This should be specially handled in our tool calling logic
        }
      }
    }

    // Check for tool_calls in the more standard format
    if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
      console.log("🛠️ Agent is using tools (standard format)");
      
      // Log all tool calls for debugging
      for (const toolCall of lastMessage.tool_calls) {
        console.log(`Tool call detected: ${toolCall.name} with args:`, toolCall.args);
        
        // If this is our scrape_website tool, ensure the URL is present
        if (toolCall.name === "scrape_website" && !toolCall.args?.url) {
          console.error("❌ Missing URL in scrape_website tool call");
          // We could potentially extract a URL from content here, but better to fix upstream
        }
      }
      
      return "tools";
    }
    
    // Check for tool_use format in the content array
    if (Array.isArray(lastMessage.content)) {
      for (const content of lastMessage.content) {
        if (content.type === "tool_use") {
          console.log("🛠️ Agent is using tools (content array format)");
          
          // Log the tool use for debugging
          console.log(`Tool use detected: ${content.tool_name} with input:`, content.input);
          
          // If this is our scrape_website tool, ensure the URL is present
          if (content.tool_name === "scrape_website" && !content.input?.url) {
            console.error("❌ Missing URL in scrape_website tool use");
            // Could potentially extract URL here if needed
          }
          
          return "tools";
        }
      }
    }
    
    console.log("🤖 Agent is responding directly");
    return "__end__";
  }

  // Define the function that calls the model
  async function callModel(state) {
    console.log("📝 Calling Anthropic model...");
    // Log a more compact version of the messages to avoid console clutter
    console.log("Current message count:", state.messages.length);
    
    // Try to extract URL before model call
    const url = getToolUseUrl(state.messages);
    console.log("Extracted URL before model call:", url);
    
    // Use the full messages array for model invocation, not just the URL
    const response = await modelWithTools.invoke(state.messages);
    console.log("✅ Received response from model");
    
    // Check if URL can be extracted from response
    if (response.tool_calls && response.tool_calls.length > 0) {
      console.log("Tool calls detected in response:", JSON.stringify(response.tool_calls));
    }
    
    return { messages: [response] };
  }

  // Define the graph
  const workflow = new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", customToolNode)  // Use custom tool node
    .addEdge("__start__", "agent")
    .addEdge("tools", "agent")
    .addConditionalEdges("agent", shouldContinue);

  // Initialize memory for persistence
  const agentCheckpointer = new MemorySaver();

  // Compile the graph
  const agent = workflow.compile({
    checkpointSaver: agentCheckpointer
  });

  console.log("✅ Agent created successfully");
  return agent;
};

// Helper function to detect if a message potentially contains a URL
export const extractUrl = (text) => {
  const urlPattern = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/g;
  const matches = text.match(urlPattern);
  
  if (matches && matches.length > 0) {
    console.log(`🔎 URL detected in message: ${matches[0]}`);
    // Return the first match
    return matches[0].startsWith("http") ? matches[0] : `https://${matches[0]}`;
  }
  
  return null;
};

// Additional helper function to extract HTML update command
export const extractHtmlUpdateCommand = (text) => {
  return parseHtmlUpdateCommand(text);
}; 