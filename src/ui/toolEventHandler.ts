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
import { t } from '../l10n';

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
  static formatToolResult(result: any, isError: boolean, maxLength: number = 20000): string {
    // Handle null/undefined
    if (result == null) {
      return isError ? t('Error: No result') : t('No result');
    }
    
    // Hermes can serialize native tool result objects into history as strings.
    // Parse those before display so search/list/read cards do not show raw JSON.
    if (typeof result === 'string') {
      const parsed = this.parseJsonMaybe(result);
      const friendly = this.formatHermesNativeResult(parsed);
      const text = friendly || result;
      return text.length > maxLength ?
        text.substring(0, maxLength) + '... (truncated)' :
        text;
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

    // Hermes native tools commonly return plain objects such as
    // { content, total_lines, truncated }, { output, exit_code },
    // or { matches_text, total_count }.
    const nativeText = this.formatHermesNativeResult(result);
    if (nativeText) {
      const text = nativeText;
      return text.length > maxLength ?
        text.substring(0, maxLength) + '... (truncated)' :
        text;
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

  private static parseJsonMaybe(value: string): any | null {
    const trimmed = value.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
      return null;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  private static formatHermesNativeResult(value: any): string {
    if (value == null) {
      return '';
    }

    if (Array.isArray(value)) {
      return value.map(item => this.formatListItem(item)).filter(Boolean).join('\n');
    }

    if (typeof value !== 'object') {
      return '';
    }

    if (typeof value.content === 'string') {
      let text = value.content;
      if (value.truncated && value.hint) {
        text += `\n\n${value.hint}`;
      }
      return text;
    }

    if (typeof value.output === 'string') {
      let text = value.output;
      if (typeof value.exit_code === 'number') {
        text = text.replace(/\s+$/, '') + `\n\nExit code: ${value.exit_code}`;
      }
      return text;
    }

    if (typeof value.matches_text === 'string') {
      return value.matches_text;
    }

    if (typeof value.listing_text === 'string') {
      return value.listing_text;
    }

    const list = Array.isArray(value.files) ? value.files :
      Array.isArray(value.paths) ? value.paths :
      Array.isArray(value.items) ? value.items :
      Array.isArray(value.results) ? value.results :
      Array.isArray(value.matches) ? value.matches :
      null;
    return list ? list.map((item: any) => this.formatListItem(item)).filter(Boolean).join('\n') : '';
  }

  private static formatListItem(item: any): string {
    if (item == null) {
      return '';
    }
    if (typeof item === 'string') {
      return item;
    }
    if (typeof item !== 'object') {
      return String(item);
    }
    const path = item.path || item.file || item.filename || item.name || item.uri || '';
    const line = item.line || item.line_number || item.row || '';
    const text = item.text || item.content || item.match || item.preview || item.summary || '';
    const prefix = path ? `${path}${line ? `:${line}` : ''}` : '';
    if (prefix && text) {
      return `${prefix}\n  ${text}`;
    }
    return prefix || text || JSON.stringify(item);
  }
}
