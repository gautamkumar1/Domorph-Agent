import { createReactAgent, ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { StateGraph,MessagesAnnotation } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph"; 
import { webScraping } from "./tools.js";
import { systemPrompt } from "./system-prompt.js";
function getToolUseUrl(messages) {
  console.log("Trying to extract URL from messages, count:", messages.length);
  
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

  const tools = [websiteScraper];
  const toolNode = new ToolNode(tools);

  // Custom handler for tool execution that provides better debugging
  async function executeTools({ messages }) {
    const lastMessage = messages[messages.length - 1];
    console.log("Executing tools for message:", lastMessage.type || "unknown type");
    
    let toolCalls = [];
    
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