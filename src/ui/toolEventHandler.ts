/**
 * Handles tool event processing for chat interfaces.
 *
 * **Important**: Tool events rendered in the chat panel represent
 * **gateway-side executions** — the agent on the OpenClaw host runs
 * `read_file`, `exec`, `write_file`, etc. on the gateway machine,
 * NOT locally inside VSCode. When you see output like
 * `read_file: /home/user/project/main.ts`, that path refers to the
 * filesystem on the gateway server, not your local workspace.
 *
 * The VSCode extension receives tool lifecycle events (`tool_start`,
 * `tool_result`) as part of the agent stream and displays them for
 * transparency, but does not participate in tool execution.
 */
export class ToolEventHandler {
  /**
   * Format tool arguments for display
   */
  static formatToolArgs(args: any): string {
    if (typeof args === 'string') {
      return args;
    }
    
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }
  
  /**
   * Extract text content from a tool result with content array
   */
  private static extractContentText(content: any[]): string {
    if (!Array.isArray(content)) {
      return '';
    }
    
    const textItems = content
      .filter(item => item.type === 'text' && typeof item.text === 'string')
      .map(item => item.text);
      
    return textItems.join('\n');
  }
  
  /**
   * Format details from a tool execution result
   */
  private static formatExecutionDetails(details: any): string {
    if (!details) {
      return '';
    }
    
    const status = details.status === 'completed' ? 
      'Success' : `Status: ${details.status || 'unknown'}`;
    
    let parts = [status];
    
    if (typeof details.exitCode === 'number') {
      parts.push(`Exit code: ${details.exitCode}`);
    }
    
    return parts.join(' | ');
  }
  
  /**
   * Format tool result, truncating if too long
   * This is used by both the server-side (directly) and referenced 
   * by the client-side JavaScript (as logic pattern)
   */
  static formatToolResult(result: any, isError: boolean, maxLength: number = 2000): string {
    // Handle null/undefined
    if (result == null) {
      return isError ? 'Error: No result' : 'No result';
    }
    
    // Handle string directly
    if (typeof result === 'string') {
      return result.length > maxLength ? 
        result.substring(0, maxLength) + '... (truncated)' : 
        result;
    }
    
    // Handle the special case of content+details structure
    if (typeof result === 'object' && result.content && result.details) {
      // Get content text
      const contentText = this.extractContentText(result.content);
      
      // Get details text
      const detailsText = this.formatExecutionDetails(result.details);
      
      // Use content text or aggregated result
      let mainText = contentText;
      if (!mainText && result.details && typeof result.details.aggregated === 'string') {
        mainText = result.details.aggregated;
      }
      
      // Combine main text with details
      if (mainText && detailsText) {
        return `${mainText}\n\n${detailsText}`;
      } else if (detailsText) {
        return detailsText;
      } else if (mainText) {
        return mainText;
      }
    }
    
    // Default object handling
    try {
      const formatted = JSON.stringify(result, null, 2);
      return formatted.length > maxLength ? 
        formatted.substring(0, maxLength) + '... (truncated)' : 
        formatted;
    } catch {
      const fallback = String(result);
      return fallback.length > maxLength ? 
        fallback.substring(0, maxLength) + '... (truncated)' : 
        fallback;
    }
  }
}
