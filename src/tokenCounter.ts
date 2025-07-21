/**
 * TokenCounter utility for accurate token estimation in streaming responses
 * Uses industry-standard character-based approximation (chars/4)
 */

import { TokenBudget, ContentSection } from './types.js';

// Configuration constants centralized for consistency
export const TOKEN_CONFIG = {
  CHARS_PER_TOKEN: 4, // Industry standard approximation
  SAFETY_MARGIN: 0.96, // 4% safety buffer for maximum utilization
  DEFAULT_TOKEN_LIMIT: 22000, // Conservative limit accounting for JSON serialization overhead
  MAX_STRING_PREVIEW: 500, // Max length for string previews
  TRUNCATION_SUFFIX: '...[truncated]'
} as const;

export class TokenCounter {
  private readonly config = TOKEN_CONFIG
  
  /**
   * Estimate token count from text content
   */
  estimateTokens(content: string | object): number {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    return Math.ceil(text.length / this.config.CHARS_PER_TOKEN);
  }

  /**
   * Estimate tokens with JSON formatting overhead
   */
  estimateTokensWithFormatting(content: any): number {
    const jsonString = JSON.stringify(content, null, 2);
    return this.estimateTokens(jsonString);
  }

  /**
   * Create a token budget with safety margin
   */
  createBudget(totalLimit: number = this.config.DEFAULT_TOKEN_LIMIT): TokenBudget {
    const safeLimit = Math.floor(totalLimit * this.config.SAFETY_MARGIN);
    return {
      total: safeLimit,
      used: 0,
      remaining: safeLimit
    };
  }

  /**
   * Update budget after consuming tokens
   */
  consumeTokens(budget: TokenBudget, tokens: number): TokenBudget {
    return {
      total: budget.total,
      used: budget.used + tokens,
      remaining: budget.remaining - tokens
    };
  }

  /**
   * Check if content fits within budget
   */
  fitsInBudget(budget: TokenBudget, content: any): boolean {
    const tokens = this.estimateTokensWithFormatting(content);
    return tokens <= budget.remaining;
  }

  /**
   * Get maximum safe content size for remaining budget
   */
  getMaxContentSize(budget: TokenBudget): number {
    // Account for JSON formatting overhead (roughly 20% more characters)
    return Math.floor(budget.remaining * this.config.CHARS_PER_TOKEN * 0.8);
  }

  /**
   * Truncate content to fit within token budget
   */
  truncateToFit(content: any, budget: TokenBudget): { content: any; truncated: boolean } {
    const tokens = this.estimateTokensWithFormatting(content);
    
    if (tokens <= budget.remaining) {
      return { content, truncated: false };
    }

    // For objects, try to truncate arrays and observations
    if (typeof content === 'object' && content !== null) {
      return this.truncateObject(content, budget);
    }

    // For strings, truncate to character limit
    if (typeof content === 'string') {
      const maxChars = this.getMaxContentSize(budget);
      return {
        content: content.substring(0, maxChars) + this.config.TRUNCATION_SUFFIX,
        truncated: true
      };
    }

    return { content: null, truncated: true };
  }

  /**
   * Truncate object content intelligently
   */
  private truncateObject(obj: any, budget: TokenBudget): { content: any; truncated: boolean } {
    const result = { ...obj };
    let truncated = false;

    // Truncate arrays (observations, methods, etc.)
    for (const [key, value] of Object.entries(result)) {
      if (Array.isArray(value)) {
        const truncatedArray = this.truncateArray(value, budget.remaining / 4); // Allocate 1/4 budget per array
        if (truncatedArray.truncated) {
          result[key] = truncatedArray.content;
          truncated = true;
        }
      } else if (typeof value === 'string' && value.length > this.config.MAX_STRING_PREVIEW) {
        // Truncate long strings (like docstrings)
        result[key] = value.substring(0, this.config.MAX_STRING_PREVIEW) + this.config.TRUNCATION_SUFFIX;
        truncated = true;
      }
    }

    return { content: result, truncated };
  }

  /**
   * Truncate array while preserving most important items
   */
  private truncateArray(arr: any[], maxTokens: number): { content: any[]; truncated: boolean } {
    if (arr.length === 0) return { content: arr, truncated: false };

    const result = [];
    let tokenCount = 0;

    for (const item of arr) {
      const itemTokens = this.estimateTokensWithFormatting(item);
      if (tokenCount + itemTokens > maxTokens && result.length > 0) {
        return { content: result, truncated: true };
      }
      result.push(item);
      tokenCount += itemTokens;
    }

    return { content: result, truncated: false };
  }

  /**
   * Create content section with token metadata
   */
  createSection(name: string, content: any, priority: number = 1): ContentSection {
    return {
      name,
      content,
      tokenCount: this.estimateTokensWithFormatting(content),
      priority
    };
  }

  /**
   * Sort sections by priority and token efficiency
   */
  prioritizeSections(sections: ContentSection[], budget: TokenBudget): ContentSection[] {
    return sections
      .sort((a, b) => {
        // Primary sort: priority (higher first)
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        // Secondary sort: token efficiency (less tokens first)
        return a.tokenCount - b.tokenCount;
      })
      .filter(section => section.tokenCount <= budget.remaining);
  }

  /**
   * Calculate statistics for token usage
   */
  getUsageStats(budget: TokenBudget): {
    utilizationPercent: number;
    remainingPercent: number;
    isNearLimit: boolean;
  } {
    const utilizationPercent = (budget.used / budget.total) * 100;
    const remainingPercent = (budget.remaining / budget.total) * 100;
    
    return {
      utilizationPercent: Math.round(utilizationPercent * 10) / 10,
      remainingPercent: Math.round(remainingPercent * 10) / 10,
      isNearLimit: utilizationPercent > 85
    };
  }

  /**
   * Serialize content with maximum token utilization
   * Dynamically cuts content to fit within token limit while maximizing usage
   */
  serializeWithMaxUtilization(content: any, tokenLimit: number = 25000): string {
    // Handle string input (already serialized)
    if (typeof content === 'string') {
      const currentTokens = this.estimateTokens(content);
      if (currentTokens <= tokenLimit * 0.98) return content;
      
      // Truncate string to fit token limit
      const maxChars = Math.floor(tokenLimit * 0.98 * this.config.CHARS_PER_TOKEN);
      return content.substring(0, maxChars) + '\n...\n"truncated": true\n}';
    }

    let serialized = JSON.stringify(content, null, 2);
    let currentTokens = this.estimateTokens(serialized);
    
    if (currentTokens <= tokenLimit * 0.98) return serialized;

    // Calculate reduction ratio based on overflow
    const reductionRatio = (tokenLimit * 0.98) / currentTokens;
    
    // Recursively apply proportional cuts to all arrays
    const workingContent = this.reduceContentRecursively(content, reductionRatio);
    
    return JSON.stringify(workingContent, null, 2);
  }

  private reduceContentRecursively(obj: any, ratio: number): any {
    if (Array.isArray(obj)) {
      const targetSize = Math.floor(obj.length * ratio);
      return obj.slice(0, Math.max(1, targetSize)).map(item => 
        this.reduceContentRecursively(item, ratio)
      );
    } else if (obj && typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.reduceContentRecursively(value, ratio);
      }
      return result;
    }
    return obj;
  }
}

// Export singleton instance
export const tokenCounter = new TokenCounter();