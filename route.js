import express from 'express';
import { createAgent, extractUrl, extractHtmlUpdateCommand } from './agent.js';
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { updateHtml, intelligentHtmlUpdate } from './tools.js';

const router = express.Router();

// Map to store user threads (simple in-memory implementation - would use a database in production)
const userThreads = new Map();

// Initialize the agent (should be configured with your Anthropic API key)
let agent = null;

// Route to interact with the agent
router.post('/chat', async (req, res) => {
  try {
    const { message, userId = 'default' } = req.body;
    
    if (!message) {
      return res.status(400).json({ 
        error: true, 
        message: "Message is required" 
      });
    }

    // Initialize agent if not already done
    if (!agent) {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) {
        return res.status(500).json({ 
          error: true, 
          message: "ANTHROPIC_API_KEY environment variable not set" 
        });
      }
      
      try {
        console.log("⚙️ Auto-configuring agent with API key from environment...");
        agent = createAgent(anthropicKey);
      } catch (error) {
        console.error("❌ Error configuring agent:", error);
        return res.status(500).json({ 
          error: true, 
          message: `Error configuring agent: ${error.message}` 
        });
      }
    }

    console.log(`📩 Received message from user ${userId}: ${message}`);
    
    // Get or create thread for this user
    if (!userThreads.has(userId)) {
      userThreads.set(userId, []);
    }
    
    const threadMessages = userThreads.get(userId);

    // IMPORTANT: First check if the message is an HTML update command - handle it directly
    const htmlUpdate = extractHtmlUpdateCommand(message);
    if (htmlUpdate) {
      console.log(`🔄 Detected HTML update command:`, htmlUpdate);
      
      if (htmlUpdate.type === "simple") {
        console.log(`   File: ${htmlUpdate.file}`);
        console.log(`   Replace: "${htmlUpdate.oldText}" with "${htmlUpdate.newText}"`);
        
        try {
          // Directly handle the simple HTML update command
          console.log("🔧 Executing simple HTML update directly, bypassing agent");
          const result = await updateHtml(htmlUpdate.file, htmlUpdate.oldText, htmlUpdate.newText);
          
          // Create an AI message with the result and add to conversation
          const updateMessage = new HumanMessage(message);
          const responseContent = `HTML update ${result.success ? 'successful' : 'failed'}: ${result.message}`;
          const updateResponse = new AIMessage({
            content: responseContent
          });
          
          // Add the messages to the thread
          threadMessages.push(updateMessage);
          threadMessages.push(updateResponse);
          
          // Send response
          console.log(`✅ HTML update completed: ${responseContent}`);
          return res.json({ 
            response: responseContent,
            threadId: userId,
            result
          });
        } catch (error) {
          console.error(`❌ Error updating HTML:`, error);
          // Continue with regular processing if update fails
        }
      } else if (htmlUpdate.type === "intelligent") {
        console.log(`   File: ${htmlUpdate.file}`);
        console.log(`   Instruction: "${htmlUpdate.instruction}"`);
        
        try {
          // Directly handle the intelligent HTML update command
          console.log("🧠 Executing intelligent HTML update directly, bypassing agent");
          const result = await intelligentHtmlUpdate(htmlUpdate.file, htmlUpdate.instruction);
          
          // Create an AI message with the result and add to conversation
          const updateMessage = new HumanMessage(message);
          const responseContent = `Intelligent HTML update ${result.success ? 'successful' : 'failed'}: ${result.message}`;
          const updateResponse = new AIMessage({
            content: responseContent
          });
          
          // Add the messages to the thread
          threadMessages.push(updateMessage);
          threadMessages.push(updateResponse);
          
          // Send response
          console.log(`✅ Intelligent HTML update completed: ${responseContent}`);
          return res.json({ 
            response: responseContent,
            threadId: userId,
            result
          });
        } catch (error) {
          console.error(`❌ Error performing intelligent HTML update:`, error);
          // Continue with regular processing if update fails
        }
      }
    }
    
    // Check if the message contains a URL (for scraping)
    const url = extractUrl(message);
    if (url) {
      console.log(`🌐 Detected URL in message: ${url}`);
    }
    
    // Update thread with new message
    const humanMessage = new HumanMessage(message);
    threadMessages.push(humanMessage);
    
    // Invoke the agent
    console.log(`🤖 Invoking agent for user ${userId}...`);
    const result = await agent.invoke(
      { messages: threadMessages },
      { configurable: { thread_id: userId } }
    );
    
    // Store the AI's response in the thread
    const aiResponse = result.messages[result.messages.length - 1];
    threadMessages.push(aiResponse);
    
    // Send response to client
    res.json({ 
      response: aiResponse.content,
      threadId: userId
    });
    
  } catch (error) {
    console.error("❌ Error processing message:", error);
    res.status(500).json({ 
      error: true, 
      message: `Error processing message: ${error.message}` 
    });
  }
});

// Route to clear a user's thread
router.post('/clear', (req, res) => {
  const { userId = 'default' } = req.body;
  
  if (userThreads.has(userId)) {
    userThreads.delete(userId);
    console.log(`🧹 Cleared thread for user ${userId}`);
  }
  
  res.json({ success: true, message: `Thread cleared for user ${userId}` });
});

// Route to get debug info about threads
router.get('/debug/threads', (req, res) => {
  const threadInfo = {};
  
  userThreads.forEach((messages, userId) => {
    threadInfo[userId] = {
      messageCount: messages.length,
      preview: messages.length > 0 ? messages[messages.length - 1].content.substring(0, 100) + '...' : ''
    };
  });
  
  res.json(threadInfo);
});

export default router;
