import BM25 from 'okapibm25';
import type { BMDocument } from 'okapibm25';
import { SearchResult } from '../types.js';

export interface BM25Config {
  k1?: number;
  b?: number;
}

export interface BM25Document {
  id: string;
  content: string;
  entityType?: string;
  observations?: string[];
  file_path?: string;
  line_number?: number;
  end_line_number?: number;
  has_implementation?: boolean;
  [key: string]: any;
}

export interface BM25SearchResult {
  document: BM25Document;
  score: number;
}

/**
 * BM25Service provides keyword-based search functionality using the OkapiBM25 algorithm.
 * Complements semantic search with exact keyword matching capabilities.
 */
export class BM25Service {
  private documents: BM25Document[] = [];
  private corpus: string[] = [];
  private config: BM25Config;
  private isIndexed: boolean = false;

  constructor(config: BM25Config = {}) {
    this.config = {
      k1: config.k1 ?? 1.2,
      b: config.b ?? 0.75,
    };
  }

  /**
   * Add documents to the BM25 index
   */
  addDocuments(documents: BM25Document[]): void {
    console.error(`[BM25Service] Adding ${documents.length} documents to corpus`);
    
    this.documents = [...this.documents, ...documents];
    this.corpus = [...this.corpus, ...documents.map(doc => {
      // Include entity name, content, type, and observations for comprehensive search
      const searchableText = [
        `${doc.id} ${doc.id}`,      // Boost entity name with 2x frequency
        doc.content,                // Main content
        doc.entityType,             // Entity type (class, function, etc.)
        ...(doc.observations || []) // User annotations
      ].filter(Boolean).join(' ');
      
      const processedText = this.prepareText(searchableText);
      
      // Debug log for CoreIndexer specifically
      if (doc.id && doc.id.includes('CoreIndexer')) {
        console.error(`[BM25Service] DEBUG CoreIndexer:`, {
          id: doc.id,
          entityType: doc.entityType,
          searchableText: searchableText.substring(0, 200) + '...',
          processedText: processedText.substring(0, 200) + '...'
        });
      }
      
      return processedText;
    })];
    
    console.error(`[BM25Service] Total corpus size: ${this.corpus.length} documents`);
    this.isIndexed = false;
  }

  /**
   * Clear all documents and reset the index
   */
  clearDocuments(): void {
    this.documents = [];
    this.corpus = [];
    this.isIndexed = false;
  }

  /**
   * Update documents in the index (replaces existing documents)
   */
  updateDocuments(documents: BM25Document[]): void {
    this.clearDocuments();
    this.addDocuments(documents);
  }

  /**
   * Search documents using BM25 keyword matching
   */
  search(query: string, limit: number = 20, entityTypes?: string[]): BM25SearchResult[] {
    if (this.documents.length === 0) {
      return [];
    }

    try {
      // Prepare query keywords (split into tokens)
      const keywords = this.prepareText(query).split(/\s+/).filter(word => word.length > 0);
      
      if (keywords.length === 0) {
        return [];
      }
      
      console.error(`[BM25Service] Searching for keywords: [${keywords.join(', ')}] in ${this.corpus.length} documents`);
      
      // Perform BM25 search  
      const scores = (BM25 as any).default(this.corpus, keywords, {
        k1: this.config.k1!,
        b: this.config.b!,
      }) as number[];
      
      // Create results with scores
      const results: BM25SearchResult[] = this.documents
        .map((doc, index) => ({
          document: doc,
          score: scores[index] || 0,
        }))
        .filter(result => result.score > 0); // Only include documents with positive scores

      // Filter by entity types if specified (ignore chunk types - always return metadata)
      let filteredResults = results;
      if (entityTypes && entityTypes.length > 0) {
        // Separate entity types from chunk types
        const knownChunkTypes = ["metadata", "implementation"];
        const actualEntityTypes = entityTypes.filter(type => !knownChunkTypes.includes(type));
        
        // Only filter by actual entity types, ignore chunk type requests
        if (actualEntityTypes.length > 0) {
          filteredResults = results.filter(result => 
            actualEntityTypes.includes(result.document.entityType || '')
          );
        }
        // If only chunk types requested (metadata/implementation), return all results
      }

      // Sort by score (descending) and limit results
      return filteredResults
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    } catch (error) {
      console.error('BM25 search error:', error);
      return [];
    }
  }

  /**
   * Get search statistics
   */
  getStats(): { documentCount: number; isIndexed: boolean; config: BM25Config } {
    return {
      documentCount: this.documents.length,
      isIndexed: this.isIndexed,
      config: this.config,
    };
  }

  /**
   * Convert BM25SearchResult to SearchResult format
   */
  static convertToSearchResult(bm25Result: BM25SearchResult, collectionName: string): SearchResult {
    const doc = bm25Result.document;
    
    // Read has_implementation from document metadata
    const hasImplementation = doc.has_implementation || false;
    
    // Match exact structure from semantic search results - spread payload like processSearchResults does
    return {
      type: 'chunk',
      score: bm25Result.score,
      data: {
        id: doc.id,
        entity_name: doc.id,
        chunk_type: 'metadata',
        content: doc.content,
        content_hash: doc.content_hash,
        created_at: doc.created_at,
        metadata: {
          entity_type: doc.entityType || 'unknown',
          file_path: doc.file_path || undefined,
          line_number: doc.line_number || undefined,
          end_line_number: doc.end_line_number || doc.line_number || undefined,
          has_implementation: hasImplementation,
          observations: doc.observations || []
        },
        collection: collectionName,
        type: 'chunk'
      } as any
    };
  }

  /**
   * Prepare text for BM25 processing (tokenization and normalization)
   */
  private prepareText(text: string): string {
    if (!text || typeof text !== 'string') {
      return '';
    }

    const tokens: string[] = [];
    
    // Original tokens (current behavior)
    const originalTokens = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(t => t.length > 0);
    
    tokens.push(...originalTokens);

    // Add camelCase split tokens
    const splitTokens = text
      .replace(/([a-z])([A-Z])/g, '$1 $2')       // camelCase → camel Case
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')  // XMLParser → XML Parser
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(t => t.length > 0);
    
    tokens.push(...splitTokens);

    return [...new Set(tokens)].join(' ');
  }
}

/**
 * Hybrid search result fusion using Reciprocal Rank Fusion (RRF)
 */
export class HybridSearchFusion {
  /**
   * Combine semantic and keyword search results using RRF algorithm
   */
  static fuseResults(
    semanticResults: SearchResult[],
    keywordResults: BM25SearchResult[],
    collectionName: string,
    semanticWeight: number = 0.7,
    keywordWeight: number = 0.3,
    rfrConstant: number = 60
  ): SearchResult[] {
    // Convert keyword results to SearchResult format
    const convertedKeywordResults = keywordResults.map(result => 
      BM25Service.convertToSearchResult(result, collectionName)
    );

    // Create maps for efficient lookup
    const semanticScores = new Map<string, { result: SearchResult; rank: number }>();
    const keywordScores = new Map<string, { result: SearchResult; rank: number }>();
    
    // Index semantic results
    semanticResults.forEach((result, index) => {
      semanticScores.set(result.data.id, { result, rank: index + 1 });
    });

    // Index keyword results
    convertedKeywordResults.forEach((result, index) => {
      keywordScores.set(result.data.id, { result, rank: index + 1 });
    });

    // Get all unique document IDs
    const allIds = new Set([
      ...semanticScores.keys(),
      ...keywordScores.keys(),
    ]);

    // Calculate hybrid scores using score-based fusion
    const hybridResults: Array<{ result: SearchResult; hybridScore: number }> = [];

    for (const id of allIds) {
      const semanticData = semanticScores.get(id);
      const keywordData = keywordScores.get(id);

      // Use original scores instead of rank-based RRF to avoid score degradation
      const semanticScore = semanticData?.result.score || 0;
      const keywordScore = keywordData?.result.score || 0;

      // Weighted combination of original scores
      const hybridScore = (semanticWeight * semanticScore) + (keywordWeight * keywordScore);

      // Use the result from whichever source has it (prefer semantic)
      const result = semanticData?.result || keywordData?.result;
      if (result) {
        hybridResults.push({
          result: {
            ...result,
            score: hybridScore, // Update with hybrid score
          },
          hybridScore,
        });
      }
    }

    // Sort by hybrid score and return results
    return hybridResults
      .sort((a, b) => b.hybridScore - a.hybridScore)
      .map(item => item.result);
  }
}