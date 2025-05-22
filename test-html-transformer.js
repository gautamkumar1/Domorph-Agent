// Test script for HTML transformer
import { intelligentHtmlUpdate } from './tools.js';

async function runTest() {
  try {
    console.log("Testing HTML transformer with different transformation types...\n");
    
    // Test 1: Simple element modification
    console.log("Test 1: Simple element modification");
    const result1 = await intelligentHtmlUpdate('/index.html', 'make the header background blue and modern');
    console.log(`Test 1 result: ${result1.success ? 'Success' : 'Failure'}\n`);
    
    // Test 2: Batch operation
    console.log("Test 2: Batch operation");
    const result2 = await intelligentHtmlUpdate('/index.html', 'make all buttons rounded and blue');
    console.log(`Test 2 result: ${result2.success ? 'Success' : 'Failure'}\n`);
    
    // Test 3: Full page redesign
    console.log("Test 3: Full page redesign");
    const result3 = await intelligentHtmlUpdate('/index.html', 'redesign the full page with a modern and clean look');
    console.log(`Test 3 result: ${result3.success ? 'Success' : 'Failure'}\n`);
    
    console.log("All tests completed!");
  } catch (error) {
    console.error("Test failed:", error);
  }
}

// Run the test
runTest(); 