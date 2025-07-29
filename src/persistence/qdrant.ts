import { QdrantClient } from "@qdrant/js-client-rest";
import OpenAI from "openai";
import crypto from "crypto";
import {
  QDRANT_URL,
  COLLECTION_NAME,
  OPENAI_API_KEY,
  QDRANT_API_KEY
} from "../config.js";
import { Entity, Relation, SmartGraph, ScrollOptions, KnowledgeGraph, SearchResult, SemanticMetadata } from "../types.js";
import { BM25Service, HybridSearchFusion } from "../bm25/bm25Service.js";

// Create custom Qdrant client that adds auth header
class CustomQdrantClient extends QdrantClient {
  constructor(url: string) {
    const parsed = new URL(url);
    super({
      url: `${parsed.protocol}//${parsed.hostname}`,
      port: parsed.port ? parseInt(parsed.port) : 6333,
      https: parsed.protocol === 'https:',
      apiKey: QDRANT_API_KEY,
      timeout: 60000,
      checkCompatibility: false
    });
  }

  // Override request method to log requests
  async getCollections() {
    const result = await super.getCollections();   
    return result;
  }
}

interface ChunkPayload {
  type: "chunk";
  chunk_type: "metadata" | "relation" | "implementation";
  entity_name: string;
  entity_type: string;
  content: string;
  file_path?: string;
  relation_target?: string;
  relation_type?: string;
  created_at?: string;
  observations?: string[];
}

interface QdrantCollectionConfig {
  params: {
    vectors: {
      size: number;
      distance: string;
    };
  };
}

interface QdrantCollectionInfo {
  config: QdrantCollectionConfig;
}

type Payload = ChunkPayload;

function isMetadataChunk(payload: ChunkPayload): boolean {
  // Extract entity_type from metadata (new format) or fallback to top-level (backward compatibility)
  const entityType = (payload as any).metadata?.entity_type || payload.entity_type;
  return (
    payload.type === "chunk" &&
    payload.chunk_type === "metadata" &&
    typeof payload.entity_name === "string" &&
    typeof entityType === "string"
  );
}

function isRelationChunk(payload: ChunkPayload): boolean {
  return (
    payload.type === "chunk" &&
    payload.chunk_type === "relation" &&
    typeof payload.entity_name === "string" &&
    typeof payload.relation_target === "string" &&
    typeof payload.relation_type === "string"
  );
}

export class QdrantPersistence {
  private client: CustomQdrantClient;
  private openai: OpenAI;
  private initialized: boolean = false;
  private vectorSize: number = 1536; // Default to OpenAI, updated after initialization
  private bm25Service: BM25Service;

  constructor() {
    if (!QDRANT_URL) {
      throw new Error("QDRANT_URL environment variable is required");
    }

    // Validate QDRANT_URL format and protocol
    if (
      !QDRANT_URL.startsWith("http://") &&
      !QDRANT_URL.startsWith("https://")
    ) {
      throw new Error("QDRANT_URL must start with http:// or https://");
    }

    this.client = new CustomQdrantClient(QDRANT_URL);

    this.openai = new OpenAI({
      apiKey: OPENAI_API_KEY,
    });

    // Initialize BM25 service for keyword search
    this.bm25Service = new BM25Service({
      k1: 1.2,
      b: 0.75,
    });
  }

  async connect() {
    if (this.initialized) return;

    // Add retry logic for initial connection with exponential backoff
    let retries = 3;
    let delay = 2000; // Start with 2 second delay

    while (retries > 0) {
      try {
        await this.client.getCollections();
        this.initialized = true;
        break;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown Qdrant error";
        console.error(`Connection attempt failed: ${message}`);
        console.error("Full error:", error);

        retries--;
        if (retries === 0) {
          throw new Error(
            `Failed to connect to Qdrant after multiple attempts: ${message}`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
      }
    }
  }

  async initialize() {
    await this.connect();

    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    try {
      // Check if collection exists
      const collections = await this.client.getCollections();
      const collection = collections.collections.find(
        (c) => c.name === COLLECTION_NAME
      );

      if (!collection) {
        // For new collections, detect embedding provider and create with appropriate vector size
        const defaultVectorSize = this.getDefaultVectorSize();
        await this.client.createCollection(COLLECTION_NAME, {
          vectors: {
            size: defaultVectorSize,
            distance: "Cosine",
          },
        });
        console.error(`Created new collection '${COLLECTION_NAME}' with ${defaultVectorSize}-dimensional vectors`);
        this.vectorSize = defaultVectorSize;
        return;
      }

      // Get collection info - accept whatever vector size exists
      const collectionInfo = (await this.client.getCollection(
        COLLECTION_NAME
      )) as QdrantCollectionInfo;
      
      // Handle both old (vectors.size) and new (vectors.dense.size) collection formats
      const vectorConfig = collectionInfo.config?.params?.vectors as any;
      const currentVectorSize = vectorConfig?.size || vectorConfig?.dense?.size;

      if (!currentVectorSize) {
        console.error(`Collection '${COLLECTION_NAME}' has no vector configuration - MCP server cannot create collections. Please index data first.`);
        return;
      }

      console.error(`Using existing collection '${COLLECTION_NAME}' with ${currentVectorSize}-dimensional vectors`);
      
      // Update embedding model based on detected vector size
      this.updateEmbeddingModel(currentVectorSize);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Qdrant error";
      console.error("Failed to initialize collection:", message);
      throw new Error(
        `Failed to initialize Qdrant collection. Please check server logs for details: ${message}`
      );
    }
  }

  private getDefaultVectorSize(): number {
    // Check environment for embedding provider preference
    const provider = process.env.EMBEDDING_PROVIDER?.toLowerCase();
    if (provider === 'voyage') {
      return 512; // Voyage embeddings
    }
    return 1536; // Default to OpenAI embeddings
  }

  private updateEmbeddingModel(vectorSize: number) {
    // Update internal vector size for dummy vectors
    this.vectorSize = vectorSize;
    
    // Update internal embedding model based on detected vector size
    if (vectorSize === 512) {
      console.error("Detected Voyage embeddings (512-dim)");
      // Note: Would need to implement Voyage embedding generation
    } else if (vectorSize === 1536) {
      console.error("Detected OpenAI embeddings (1536-dim)");
    } else {
      console.error(`Unknown vector size: ${vectorSize}, using OpenAI embeddings`);
    }
  }

  private async recreateCollection(vectorSize: number) {
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required in recreateCollection");
    }

    try {
      await this.client.deleteCollection(COLLECTION_NAME);
      await this.client.createCollection(COLLECTION_NAME, {
        vectors: {
          size: vectorSize,
          distance: "Cosine",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Qdrant error";
      throw new Error(`Failed to recreate collection: ${message}`);
    }
  }

  private async generateEmbedding(text: string) {
    const provider = process.env.EMBEDDING_PROVIDER?.toLowerCase();
    
    if (provider === 'voyage') {
      return this.generateVoyageEmbedding(text);
    } else {
      return this.generateOpenAIEmbedding(text);
    }
  }

  private async generateOpenAIEmbedding(text: string) {
    try {
      const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
      const response = await this.openai.embeddings.create({
        model,
        input: text,
      });
      return response.data[0].embedding;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown OpenAI error";
      console.error("OpenAI embedding error:", message);
      throw new Error(`Failed to generate embeddings with OpenAI: ${message}`);
    }
  }

  private async generateVoyageEmbedding(text: string) {
    try {
      const voyageApiKey = process.env.VOYAGE_API_KEY;
      if (!voyageApiKey) {
        throw new Error("VOYAGE_API_KEY environment variable is required for Voyage embeddings");
      }

      const model = process.env.EMBEDDING_MODEL || "voyage-3-lite";
      
      const response = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${voyageApiKey}`,
        },
        body: JSON.stringify({
          input: text,
          model: model,
          input_type: "document",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Voyage API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      return data.data[0].embedding;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Voyage error";
      console.error("Voyage embedding error:", message);
      throw new Error(`Failed to generate embeddings with Voyage: ${message}`);
    }
  }

  private async hashString(str: string) {
    const hash = crypto.createHash("sha256");
    hash.update(str);
    const buffer = hash.digest();
    return buffer.readUInt32BE(0);
  }

  async persistEntity(entity: Entity) {
    await this.connect();
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    const text = `${entity.name} (${
      entity.entityType
    }): ${(entity.observations || []).join(". ")}`;
    const vector = await this.generateEmbedding(text);
    
    // Use consistent chunk ID format: {file_path}::{entity_name}::metadata
    // For manual entities without file_path, use "manual" as file identifier
    const idStr = `manual::${entity.name}::metadata`;
    const id = await this.hashString(idStr);

    const payload = {
      type: "chunk",
      chunk_type: "metadata",
      entity_name: entity.name,
      entity_type: entity.entityType,
      observations: entity.observations || [],  // Store as array for MCP compatibility
      content: (entity.observations || []).join(". "),  // Keep joined text for embedding
      file_path: undefined, // Could be extracted from observations if needed
      created_at: new Date().toISOString()
    };

    await this.client.upsert(COLLECTION_NAME, {
      points: [
        {
          id,
          vector,
          payload: payload as Record<string, unknown>,
        },
      ],
    });
  }

  async persistRelation(relation: Relation) {
    await this.connect();
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    const text = `${relation.from} ${relation.relationType} ${relation.to}`;
    const vector = await this.generateEmbedding(text);
    
    // Use consistent chunk ID format for relations
    const relationId = `${relation.from}-${relation.relationType}-${relation.to}`;
    const idStr = `relation::${relationId}::relation`;
    const id = await this.hashString(idStr);

    const payload = {
      type: "chunk",
      chunk_type: "relation", 
      entity_name: relationId,
      entity_type: "relation",
      content: `${relation.from} ${relation.relationType} ${relation.to}`,
      from: relation.from,
      to: relation.to,
      relation_type: relation.relationType,
      created_at: new Date().toISOString()
    };

    await this.client.upsert(COLLECTION_NAME, {
      points: [
        {
          id,
          vector,
          payload: payload as Record<string, unknown>,
        },
      ],
    });
  }

  async searchSimilar(query: string, entityTypes?: string[], limit: number = 20, searchMode: 'semantic' | 'keyword' | 'hybrid' = 'semantic') {
    await this.connect();
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    try {
      switch (searchMode) {
        case 'semantic':
          return await this.performSemanticSearch(query, entityTypes, limit);
        case 'keyword':
          return await this.performKeywordSearch(query, entityTypes, limit);
        case 'hybrid':
          return await this.performHybridSearch(query, entityTypes, limit);
        default:
          throw new Error(`Unsupported search mode: ${searchMode}`);
      }
    } catch (error) {
      console.error(`Search error (${searchMode}):`, error);
      return [];
    }
  }

  private async performSemanticSearch(query: string, entityTypes?: string[], limit: number = 20): Promise<SearchResult[]> {
    const queryVector = await this.generateEmbedding(query);

    // Build filter based on entityTypes (supports both entity types and chunk types with OR logic)
    const filter = this.buildEntityTypeFilter(entityTypes);

    const results = await this.client.search(COLLECTION_NAME!, {
      vector: {
        name: 'dense',
        vector: queryVector
      },
      limit,
      with_payload: true,
      filter
    });

    return this.processSearchResults(results);
  }

  private async performKeywordSearch(query: string, entityTypes?: string[], limit: number = 20): Promise<SearchResult[]> {
    await this.connect();
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    // Use BM25Service directly (same as hybrid search) - fixes hardcoded vocabulary issue
    await this.initializeBM25Index();
    const bm25Results = this.bm25Service.search(query, limit, entityTypes);
    return bm25Results.map(result => BM25Service.convertToSearchResult(result, COLLECTION_NAME!));
  }

  private async performHybridSearch(query: string, entityTypes?: string[], limit: number = 20): Promise<SearchResult[]> {
    // Perform both semantic and keyword searches in parallel
    const [semanticResults, keywordResults] = await Promise.all([
      this.performSemanticSearch(query, entityTypes, limit),
      Promise.resolve(this.bm25Service.search(query, limit, entityTypes)),
    ]);

    // Fuse results using Reciprocal Rank Fusion algorithm
    const hybridResults = HybridSearchFusion.fuseResults(
      semanticResults,
      keywordResults,
      COLLECTION_NAME!,
      0.7, // semantic weight
      0.3, // keyword weight
      60   // RRF constant
    );

    return hybridResults.slice(0, limit);
  }

  private buildEntityTypeFilter(entityTypes?: string[]): any {
    if (!entityTypes || entityTypes.length === 0) {
      return undefined;
    }

    // Separate entity types from chunk types
    const knownChunkTypes = ["metadata", "implementation"];
    const chunkTypes = entityTypes.filter(type => knownChunkTypes.includes(type));
    const actualEntityTypes = entityTypes.filter(type => !knownChunkTypes.includes(type));
    
    const filterConditions = [];
    
    // Add entity_type filter if we have actual entity types
    if (actualEntityTypes.length > 0) {
      filterConditions.push({
        should: [
          {
            key: "entity_type",
            match: {
              any: actualEntityTypes
            }
          },
          {
            key: "metadata.entity_type",
            match: {
              any: actualEntityTypes
            }
          }
        ]
      });
    }
    
    // Add chunk_type filter if we have chunk types
    if (chunkTypes.length > 0) {
      filterConditions.push({
        key: "chunk_type",
        match: {
          any: chunkTypes
        }
      });
    }
    
    // Build final filter structure with OR logic
    if (filterConditions.length === 0) {
      return undefined;
    } else if (filterConditions.length === 1) {
      // Single filter condition - use must
      return {
        must: filterConditions
      };
    } else {
      // Multiple filter conditions - use should for OR logic
      return {
        should: filterConditions
      };
    }
  }

  private processSearchResults(results: any[]): SearchResult[] {
    const validResults: SearchResult[] = [];

    for (const result of results) {
      if (!result.payload) continue;

      const payload = result.payload as unknown as any;

      if (payload.chunk_type) {
        // Handle v2.4 chunk format only
        // Handle both 'name' and 'entity_name' field variations
        const entityName = payload.entity_name || (payload as any).name || 'unknown';

        // Enhanced scoring system for progressive disclosure and debugging workflow
        let score = result.score;
        if (payload.chunk_type === 'metadata') {
          score *= 1.4; // 40% boost for metadata chunks (progressive disclosure priority)
        } else if (payload.chunk_type === 'implementation') {
          score *= 1.2; // 20% boost for implementation chunks
        } else {
          // Extract entity_type from metadata (new format) or fallback to top-level (backward compatibility)
          const entityType = (payload as any).metadata?.entity_type || payload.entity_type;
          if (entityType) {
            // Research-validated entity type priorities for debugging workflow
            const entityBoosts: Record<string, number> = {
              'function': 1.3, 'class': 1.3, 'method': 1.3, // 30% - Core executable code
              'interface': 1.15, 'type': 1.15,               // 15% - Contracts & types (IDD)
              'const': 1.1, 'variable': 1.1,                // 10% - Configuration & state
              'import': 1.05                                 // 5% - Dependencies
            };
            score *= entityBoosts[entityType] || 1.0;
          }
        }
          
        validResults.push({
          type: 'chunk',
          score: score,
          data: {
            ...payload,
            entity_name: entityName, // Normalize field name
            ...(payload.observations && { observations: payload.observations }) // Only include observations if they exist
          }
        });
      }
    }

    // Sort by score (highest first) after applying boosts
    validResults.sort((a, b) => b.score - a.score);

    return validResults;
  }

  private async initializeBM25Index(): Promise<void> {
    // Always rebuild BM25 index to ensure entity names are included in content
    const stats = this.bm25Service.getStats();
    console.error(`🔥 FORCE REBUILDING BM25 INDEX - was ${stats.documentCount} docs`);
    console.error(`[DEBUG] initializeBM25Index called from qdrant.ts line 572`);
    this.bm25Service.clearDocuments();
    
    // Force clear any cached state
    console.error(`🧹 BM25 cache cleared, rebuilding with entity names...`);

    try {
      await this.connect();
      if (!COLLECTION_NAME) {
        throw new Error("COLLECTION_NAME environment variable is required");
      }

      // Get all metadata chunks from Qdrant for BM25 indexing
      const metadataChunks: any[] = [];
      let offset: string | number | undefined = undefined;
      const limit = 100;

      do {
        const scrollResult = await this.client.scroll(COLLECTION_NAME, {
          limit,
          offset,
          with_payload: true,
          with_vector: false,
          filter: {
            must: [
              { key: "type", match: { value: "chunk" } },
              { key: "chunk_type", match: { value: "metadata" } }
            ]
          }
        });

        for (const point of scrollResult.points) {
          if (point.payload) {
            metadataChunks.push(point.payload);
          }
        }

        offset = (typeof scrollResult.next_page_offset === 'string' || typeof scrollResult.next_page_offset === 'number') 
          ? scrollResult.next_page_offset 
          : undefined;
      } while (offset !== null && offset !== undefined);

      // Convert metadata chunks to BM25 documents with complete metadata
      const bm25Documents = metadataChunks.map((chunk: any) => ({
        id: chunk.entity_name || chunk.id,
        content: `${chunk.entity_name || chunk.id} ${chunk.content || ''}`.trim(),
        entityType: chunk.metadata?.entity_type || chunk.entity_type || 'unknown',
        observations: chunk.metadata?.observations || chunk.observations || [],
        file_path: chunk.metadata?.file_path || chunk.file_path,
        line_number: chunk.metadata?.line_number || chunk.line_number,
        end_line_number: chunk.metadata?.end_line_number || chunk.end_line_number,
        has_implementation: chunk.metadata?.has_implementation || chunk.has_implementation || false,
        ...chunk, // Include all original chunk fields including content_hash, created_at
      }));

      // Index documents in BM25 service
      console.error(`[DEBUG] About to call bm25Service.updateDocuments with ${bm25Documents.length} documents from qdrant.ts initializeBM25Index`);
      this.bm25Service.updateDocuments(bm25Documents);
      
      console.error(`BM25 index initialized with ${bm25Documents.length} metadata chunks`);
    } catch (error) {
      console.error('Failed to initialize BM25 index:', error);
    }
  }

  async getImplementationChunks(
    entityName: string, 
    scope: 'minimal' | 'logical' | 'dependencies' = 'minimal',
    limit?: number
  ): Promise<SearchResult[]> {
    await this.connect();
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    // Base implementation for minimal scope
    const baseResults = await this.getEntityImplementation(entityName);
    
    if (scope === 'minimal') return baseResults;
    
    // Extract semantic metadata for scope expansion
    const metadata = this.extractSemanticMetadata(baseResults);
    
    if (scope === 'logical') {
      return this.expandLogicalScope(baseResults, metadata, limit);
    }
    
    if (scope === 'dependencies') {
      return this.expandDependencyScope(baseResults, metadata, limit);
    }
    
    return baseResults;
  }

  private async getEntityImplementation(entityName: string): Promise<SearchResult[]> {
    try {
      // Search for implementation chunks for the specific entity
      const results = await this.client.search(COLLECTION_NAME!, {
        vector: {
          name: 'dense',
          vector: new Array(this.vectorSize).fill(0) // Dummy vector for filter-only search
        },
        limit: 50, // Optimized: Minimal scope maintained at 50 (no change needed)
        with_payload: true,
        filter: {
          must: [
            { key: "entity_name", match: { value: entityName } },
            { key: "chunk_type", match: { value: "implementation" } }
          ]
        }
      });

      const validResults: SearchResult[] = [];

      for (const result of results) {
        if (!result.payload) continue;

        const payload = result.payload as unknown as any;
        
        if (payload.chunk_type === 'implementation') {
          validResults.push({
            type: 'chunk',
            score: result.score,
            data: {
              ...payload,
              has_implementation: false // Implementation chunks don't need this flag
            }
          });
        }
      }

      return validResults;
    } catch (error) {
      console.error(`Failed to get implementation chunks for ${entityName}:`, error);
      return [];
    }
  }

  private extractSemanticMetadata(baseResults: SearchResult[]): SemanticMetadata {
    if (baseResults.length === 0) {
      return { calls: [], imports_used: [], file_path: undefined };
    }

    const firstResult = baseResults[0];
    const filePath = (firstResult.data as any).metadata?.file_path;

    // Use structured semantic metadata from indexing process if available
    const structuredMetadata = (firstResult.data as any).semantic_metadata;
    if (structuredMetadata) {
      return {
        calls: structuredMetadata.calls || [],
        imports_used: structuredMetadata.imports_used || [],
        file_path: filePath,
        exceptions_handled: structuredMetadata.exceptions_handled || [],
        complexity: structuredMetadata.complexity,
        inferred_types: structuredMetadata.inferred_types || []
      };
    }

    // Fallback to content parsing if structured metadata not available
    const content = firstResult.data.content;
    const metadata: SemanticMetadata = {
      calls: this.extractCalls(content),
      imports_used: this.extractImports(content),
      file_path: filePath
    };

    return metadata;
  }

  private extractCalls(content: string): string[] {
    // Simple regex to find function calls - in production this would use AST
    const callMatches = content.match(/(\w+)\s*\(/g) || [];
    return callMatches
      .map(match => match.replace(/\s*\($/, ''))
      .filter(call => call.length > 1)
      .slice(0, 10); // Limit to prevent overwhelming results
  }

  private extractImports(content: string): string[] {
    // Simple regex to find imports - in production this would use AST  
    const importMatches = content.match(/(?:import|from)\s+(\w+)/g) || [];
    return importMatches
      .map(match => match.replace(/(?:import|from)\s+/, ''))
      .filter(imp => imp.length > 0)
      .slice(0, 10); // Limit to prevent overwhelming results
  }

  private async expandLogicalScope(
    baseResults: SearchResult[], 
    metadata: SemanticMetadata,
    limit?: number
  ): Promise<SearchResult[]> {
    if (!metadata.file_path) {
      return baseResults;
    }

    try {
      // Query for functions called by this entity AND private helper functions in the same file
      const searchCriteria = [];
      
      // Add called functions if available
      if (metadata.calls && metadata.calls.length > 0) {
        searchCriteria.push({ key: "entity_name", match: { any: metadata.calls } });
      }
      
      // Also search for private helper functions (starting with _) in the same file
      const helperResults = await this.client.search(COLLECTION_NAME!, {
        vector: {
          name: 'dense',
          vector: new Array(this.vectorSize).fill(0)
        },
        limit: limit || 12, // Optimized: Reduced from 25 to 12 to prevent token overflow
        with_payload: true,
        filter: {
          must: [
            { key: "file_path", match: { value: metadata.file_path } },
            { key: "chunk_type", match: { value: "implementation" } }
          ],
          should: searchCriteria
        }
      });

      const additionalResults: SearchResult[] = [];
      for (const result of helperResults) {
        if (!result.payload) continue;
        const payload = result.payload as unknown as any;
        
        // Include if it's called by the entity OR if it's a private helper function in same file
        const entityName = payload.entity_name || '';
        const isCalled = metadata.calls?.includes(entityName);
        const isPrivateHelper = entityName.startsWith('_');
        
        if (isCalled || isPrivateHelper) {
          additionalResults.push({
            type: 'chunk',
            score: result.score,
            data: {
              ...payload,
              has_implementation: false
            }
          });
        }
      }

      return this.mergeAndDeduplicate([...baseResults, ...additionalResults]);
    } catch (error) {
      console.error('Failed to expand logical scope:', error);
      return baseResults;
    }
  }

  private async expandDependencyScope(
    baseResults: SearchResult[], 
    metadata: SemanticMetadata,
    limit?: number
  ): Promise<SearchResult[]> {
    const imports = metadata.imports_used || [];
    const calls = metadata.calls || [];
    
    if (imports.length === 0 && calls.length === 0) {
      return baseResults;
    }

    try {
      // Query for imported dependencies
      const dependencyResults = await this.client.search(COLLECTION_NAME!, {
        vector: {
          name: 'dense',
          vector: new Array(this.vectorSize).fill(0)
        },
        limit: limit || 40,
        with_payload: true,
        filter: {
          must: [
            { key: "chunk_type", match: { value: "implementation" } }
          ],
          should: [
            { key: "entity_name", match: { any: imports } },
            { key: "entity_name", match: { any: calls } }
          ]
        }
      });

      const additionalResults: SearchResult[] = [];
      for (const result of dependencyResults) {
        if (!result.payload) continue;
        const payload = result.payload as unknown as any;
        
        additionalResults.push({
          type: 'chunk',
          score: result.score,
          data: {
            ...payload,
            has_implementation: false
          }
        });
      }

      return this.mergeAndDeduplicate([...baseResults, ...additionalResults]);
    } catch (error) {
      console.error('Failed to expand dependency scope:', error);
      return baseResults;
    }
  }

  private mergeAndDeduplicate(results: SearchResult[]): SearchResult[] {
    const entityMap = new Map<string, SearchResult>();

    for (const result of results) {
      const key = result.data.entity_name || 'unknown';
      const existing = entityMap.get(key);
      
      // Keep the result with the highest relevance score
      if (!existing || result.score > existing.score) {
        entityMap.set(key, result);
      }
    }

    // Return results in original insertion order for predictable results
    const deduplicated: SearchResult[] = [];
    const processedKeys = new Set<string>();
    
    for (const result of results) {
      const key = result.data.entity_name || 'unknown';
      if (!processedKeys.has(key)) {
        processedKeys.add(key);
        deduplicated.push(entityMap.get(key)!);
      }
    }

    return deduplicated;
  }

  private async _checkImplementationExists(entityName: string): Promise<boolean> {
    try {
      // Quick existence check for implementation chunks
      const results = await this.client.search(COLLECTION_NAME!, {
        vector: {
          name: 'dense',
          vector: new Array(this.vectorSize).fill(0) // Dummy vector for filter-only search
        },
        limit: 1,
        with_payload: false,
        filter: {
          must: [
            { key: "entity_name", match: { value: entityName } },
            { key: "chunk_type", match: { value: "implementation" } }
          ]
        }
      });
      
      return results.length > 0;
    } catch {
      return false;
    }
  }

  async deleteEntity(entityName: string) {
    await this.connect();
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    // Delete ALL chunks with matching entity_name (metadata + implementation chunks)
    await this.client.delete(COLLECTION_NAME, {
      filter: {
        must: [
          {
            key: "entity_name",
            match: {
              value: entityName
            }
          }
        ]
      }
    });
  }

  async deleteRelation(relation: Relation) {
    await this.connect();
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    // Use consistent chunk ID format for relations
    const relationId = `${relation.from}-${relation.relationType}-${relation.to}`;
    const idStr = `relation::${relationId}::relation`;
    const id = await this.hashString(idStr);
    
    await this.client.delete(COLLECTION_NAME, {
      points: [id],
    });
  }

  async scrollAll(options?: ScrollOptions): Promise<KnowledgeGraph | SmartGraph> {
    await this.initialize();  // Use initialize() instead of connect() to detect vector size
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }


    const mode = options?.mode || 'smart';
    const entityTypeFilter = options?.entityTypes;
    const limitPerType = options?.limit || 10000; // Allow much higher default for BM25 corpus building

    // First, get raw data from Qdrant with limit enforcement and entityTypes filtering
    const rawData = await this._getRawData(limitPerType, entityTypeFilter);

    console.error(`DEBUG DEEP: rawData.entities first 3:`, rawData.entities.slice(0, 3).map(e => ({ name: e.name, entityType: e.entityType })));
    console.error(`DEBUG DEEP: rawData.relations first 3:`, rawData.relations.slice(0, 3).map(r => ({ from: r.from, to: r.to, relationType: r.relationType })));

    // Qdrant already filtered by entityTypes, no additional filtering needed
    let filteredEntities = rawData.entities;
    let filteredRelations = rawData.relations;
    
    // For entities mode with entityTypes filtering, filter relations to only show relevant ones
    console.error(`DEBUG: mode="${mode}", entityTypeFilter=${JSON.stringify(entityTypeFilter)}, entities.length=${filteredEntities.length}, relations.length=${filteredRelations.length}`);
    
    if (entityTypeFilter && entityTypeFilter.length > 0) {
      console.error(`DEBUG: Filtering relations for entityTypes filter (mode: ${mode})`);
      console.error(`DEBUG: Relations before filtering:`, filteredRelations.length);
      filteredRelations = this.filterRelationsForEntities(filteredRelations, filteredEntities);
      console.error(`DEBUG: Relations after filtering:`, filteredRelations.length);
    }

    // Apply mode-specific filtering before returning
    switch (mode) {
      case "relationships":
        // For relationships mode, find entities that match the relation endpoints
        const relationEntityNames = new Set<string>();
        filteredRelations.forEach(rel => {
          relationEntityNames.add(rel.from);
          relationEntityNames.add(rel.to);
        });
        console.error(`DEBUG: relationships mode - searching for entities matching relation endpoints:`, Array.from(relationEntityNames).slice(0, 5));
        
        // Search for entities whose names match the relation endpoints
        const matchedEntities = await this.fetchEntitiesByNames(Array.from(relationEntityNames), limitPerType);
        console.error(`DEBUG: relationships mode - found ${matchedEntities.length} matching entities from ${relationEntityNames.size} relation endpoints`);
        
        // Filter relations to only include those connecting the matched entities
        const matchedEntityNames = new Set(matchedEntities.map(e => e.name));
        const matchedRelations = filteredRelations.filter(rel => 
          matchedEntityNames.has(rel.from) && matchedEntityNames.has(rel.to)
        );
        console.error(`DEBUG: relationships mode - filtered from ${filteredRelations.length} to ${matchedRelations.length} relations connecting matched entities`);
        
        return { entities: matchedEntities, relations: matchedRelations };
      
      case "entities":
      case "smart":
      case "raw":
      default:
        // All other modes return all entities
        return { entities: filteredEntities, relations: filteredRelations };
    }
  }

  private async _getRawData(limit?: number, entityTypes?: string[]): Promise<{ entities: Entity[], relations: Relation[] }> {
    // Convert v2.4 chunks back to legacy format for read_graph compatibility
    console.error(`DEBUG _getRawData: Starting with limit=${limit}, entityTypes=${JSON.stringify(entityTypes)}`);
    const entities: Entity[] = [];
    const relations: Relation[] = [];
    const allEntities: Entity[] = []; // Track all entities for relation type filtering
    let offset: string | number | undefined = undefined;
    const batchSize = 100;
    
    // If limit is specified, track how many entities we've collected
    let entityCount = 0;
    const maxEntities = limit || Number.MAX_SAFE_INTEGER;

    // Build filter for entityTypes - filter entities, keep all relations  
    const filter: any = {
      must: [
        { key: "type", match: { value: "chunk" } }
      ]
    };

    do {
      const scrollResult = await this.client.scroll(COLLECTION_NAME!, {
        limit: batchSize,
        offset,
        with_payload: true,
        with_vector: false,
        filter: filter
      });

      
      for (const point of scrollResult.points) {
        if (!point.payload) continue;
        const payload = point.payload as unknown as ChunkPayload;

        if (payload.type === "chunk") {
          console.error('Processing chunk:', payload.chunk_type, payload.entity_name);
          if (payload.chunk_type === 'metadata') {
            // Only add entity if we haven't reached the limit AND passes entityTypes filter
            if (entityCount < maxEntities) {
              // Check entityTypes filter - if specified, only include matching entities
              let passesFilter = true;
              if (entityTypes && entityTypes.length > 0) {
                // Exclude chunk types from entityTypes filtering
                const knownChunkTypes = ["metadata", "implementation"];
                const actualEntityTypes = entityTypes.filter(type => !knownChunkTypes.includes(type));
                
                if (actualEntityTypes.length > 0) {
                  // Extract entity_type from metadata (new format) or fallback to top-level (backward compatibility)
                  const entityType = (payload as any).metadata?.entity_type || payload.entity_type;
                  passesFilter = actualEntityTypes.includes(entityType);
                }
              }
              
              // Always track all entities for relation type filtering
              const entityName = (payload as any).entity_name || (payload as any).name || 'unknown';
              // Extract entity_type from metadata (new format) or fallback to top-level (backward compatibility)
              const entityType = (payload as any).metadata?.entity_type || payload.entity_type;
              const entity = {
                name: entityName,
                entityType: entityType,
                observations: payload.observations || (payload as any).metadata?.observations || []
              };
              allEntities.push(entity);
              
              if (passesFilter) {
                entities.push(entity);
                entityCount++;
              }
            }
          } else if (payload.chunk_type === 'relation') {
            // Always process relations regardless of entity limit
            // Handle actual stored field names: entity_name -> from, relation_target -> to
            const from = (payload as any).entity_name || (payload as any).from;
            const to = (payload as any).relation_target || (payload as any).to;
            const relationType = payload.relation_type || (payload as any).relationType;
            
            console.error('Processing relation:', { from, to, relationType, payload });
            
            if (from && to && relationType) {
              relations.push({
                from: from,
                to: to,
                relationType: relationType
              });
              console.error('Added relation:', { from, to, relationType });
            } else {
              console.error('Skipped relation - missing fields:', { from, to, relationType });
            }
          }
        }
      }

      offset = (typeof scrollResult.next_page_offset === 'string' || typeof scrollResult.next_page_offset === 'number') 
        ? scrollResult.next_page_offset 
        : undefined;
        
      // Continue scrolling for relations even after entity limit reached
      // Only exit if we've collected enough entities AND no more pages
      if (entityCount >= maxEntities && offset === null) {
        break;
      }
    } while (offset !== null && offset !== undefined);

    // Filter relations by entity types if specified
    const filteredRelations = this.filterRelationsByEntityTypes(relations, allEntities, entityTypes);
    
    console.error(`DEBUG _getRawData: Returning ${entities.length} entities, ${filteredRelations.length} relations`);
    console.error(`DEBUG _getRawData: Sample entities:`, entities.slice(0, 2).map(e => ({ name: e.name, entityType: e.entityType })));
    console.error(`DEBUG _getRawData: Sample relations:`, filteredRelations.slice(0, 2).map(r => ({ from: r.from, to: r.to, relationType: r.relationType })));
    
    return { entities, relations: filteredRelations };
  }

  private _buildEntitiesResponse(entities: Entity[], relations: Relation[], limitPerType: number): KnowledgeGraph {
    // Group entities by type and apply limits
    const entityByType: Record<string, Entity[]> = {};
    
    entities.forEach(entity => {
      if (!entityByType[entity.entityType]) {
        entityByType[entity.entityType] = [];
      }
      entityByType[entity.entityType].push(entity);
    });

    // Apply priority scoring and limits
    const limitedEntities: Entity[] = [];
    Object.entries(entityByType).forEach(([type, typeEntities]) => {
      const prioritized = this._prioritizeEntities(typeEntities);
      limitedEntities.push(...prioritized.slice(0, limitPerType));
    });

    return { entities: limitedEntities, relations };
  }

  private _buildRelationshipsResponse(entities: Entity[], relations: Relation[]): KnowledgeGraph {
    // Focus on key relationship types
    const keyRelationTypes = ['inherits', 'implements', 'contains', 'imports', 'calls'];
    const keyRelations = relations.filter(r => keyRelationTypes.includes(r.relationType));
    
    // Include entities that participate in key relationships
    const participatingEntityNames = new Set<string>();
    keyRelations.forEach(r => {
      participatingEntityNames.add(r.from);
      participatingEntityNames.add(r.to);
    });

    const participatingEntities = entities.filter(e => participatingEntityNames.has(e.name));

    return { entities: participatingEntities, relations: keyRelations };
  }

  private _buildSmartResponse(entities: Entity[], relations: Relation[], limitPerType: number): SmartGraph {
    // Build comprehensive smart response
    const breakdown: Record<string, number> = {};
    entities.forEach(e => {
      breakdown[e.entityType] = (breakdown[e.entityType] || 0) + 1;
    });

    // Get key modules from file paths
    const keyModules = this._extractKeyModules(entities);

    // Build file structure
    const structure = this._buildFileStructure(entities);

    // Extract API surface (prioritized public functions and classes)
    const apiSurface = this._extractApiSurface(entities, relations, limitPerType);

    // Analyze dependencies
    const dependencies = this._analyzeDependencies(entities, relations);

    // Extract key relationships
    const keyRelations = this._extractKeyRelations(relations);

    return {
      summary: {
        totalEntities: entities.length,
        totalRelations: relations.length,
        breakdown,
        keyModules,
        timestamp: new Date().toISOString()
      },
      structure,
      apiSurface,
      dependencies,
      relations: keyRelations
    };
  }

  private _prioritizeEntities(entities: Entity[]): Entity[] {
    return entities.sort((a, b) => {
      let scoreA = 0;
      let scoreB = 0;

      // Public API bonus (not starting with underscore)
      if (a.name && typeof a.name === 'string' && !a.name.startsWith('_')) scoreA += 5;
      if (b.name && typeof b.name === 'string' && !b.name.startsWith('_')) scoreB += 5;

      // Has documentation bonus
      const aHasDoc = (a.observations || []).some(obs => obs.includes('docstring') || obs.includes('Description'));
      const bHasDoc = (b.observations || []).some(obs => obs.includes('docstring') || obs.includes('Description'));
      if (aHasDoc) scoreA += 10;
      if (bHasDoc) scoreB += 10;

      // Special method bonus (__init__, __new__)
      if (a.name && ['__init__', '__new__'].includes(a.name)) scoreA += 8;
      if (b.name && ['__init__', '__new__'].includes(b.name)) scoreB += 8;

      return scoreB - scoreA;
    });
  }

  private _extractKeyModules(entities: Entity[]): string[] {
    const modules = new Set<string>();
    entities.forEach(entity => {
      const obs = (entity.observations || []).find(o => o.includes('Defined in:') || o.includes('file_path'));
      if (obs) {
        const pathMatch = obs.match(/[\/\\]([^\/\\]+)[\/\\][^\/\\]+\.py/);
        if (pathMatch) {
          modules.add(pathMatch[1]);
        }
      }
    });
    return Array.from(modules).slice(0, 10); // Top 10 modules
  }

  private _buildFileStructure(entities: Entity[]): Record<string, any> {
    const structure: Record<string, any> = {};
    
    entities.forEach(entity => {
      if (entity.entityType === 'file' || entity.entityType === 'directory') {
        const pathObs = (entity.observations || []).find(o => o.includes('file_path') || o.includes('Defined in:'));
        if (pathObs) {
          const path = entity.name;
          const entityCount = entities.filter(e => 
            (e.observations || []).some(obs => obs.includes(path))
          ).length;

          structure[path] = {
            type: entity.entityType as 'file' | 'directory',
            entities: entityCount
          };
        }
      }
    });

    return structure;
  }

  private _extractApiSurface(entities: Entity[], relations: Relation[], limit: number) {
    const classes = entities
      .filter(e => e.entityType === 'class' && e.name && !e.name.startsWith('_'))
      .slice(0, limit)
      .map(cls => {
        const fileObs = (cls.observations || []).find(o => o.includes('Defined in:'));
        const lineObs = (cls.observations || []).find(o => o.includes('Line:'));
        const docObs = (cls.observations || []).find(o => o.includes('docstring') || o.includes('Description'));
        
        // Find methods of this class
        const methods = entities
          .filter(e => e.entityType === 'method' || e.entityType === 'function')
          .filter(e => (e.observations || []).some(obs => obs.includes(cls.name)))
          .map(m => m.name)
          .slice(0, 10); // Limit methods shown

        // Find inheritance
        const inherits = relations
          .filter(r => r.relationType === 'inherits' && r.from === cls.name)
          .map(r => r.to);

        return {
          name: cls.name,
          file: fileObs ? fileObs.replace('Defined in:', '').trim() : '',
          line: lineObs ? parseInt(lineObs.replace('Line:', '').trim()) : 0,
          docstring: docObs ? docObs.replace(/.*docstring[:\s]*/, '').trim() : undefined,
          methods,
          inherits: inherits.length > 0 ? inherits : undefined,
          observations: (cls.observations || []).length > 0 ? cls.observations : undefined
        };
      });

    const functions = entities
      .filter(e => (e.entityType === 'function' || e.entityType === 'method') && e.name && !e.name.startsWith('_'))
      .slice(0, limit)
      .map(fn => {
        const fileObs = (fn.observations || []).find(o => o.includes('Defined in:'));
        const lineObs = (fn.observations || []).find(o => o.includes('Line:'));
        const sigObs = (fn.observations || []).find(o => o.includes('Signature:') || o.includes('('));
        const docObs = (fn.observations || []).find(o => o.includes('docstring') || o.includes('Description'));

        return {
          name: fn.name,
          file: fileObs ? fileObs.replace('Defined in:', '').trim() : '',
          line: lineObs ? parseInt(lineObs.replace('Line:', '').trim()) : 0,
          signature: sigObs ? sigObs.trim() : undefined,
          docstring: docObs ? docObs.replace(/.*docstring[:\s]*/, '').trim() : undefined,
          observations: (fn.observations || []).length > 0 ? fn.observations : undefined
        };
      });

    return { classes, functions };
  }

  private _analyzeDependencies(entities: Entity[], relations: Relation[]) {
    const importRelations = relations.filter(r => r.relationType === 'imports');
    
    // External dependencies (likely packages)
    const external = new Set<string>();
    importRelations.forEach(rel => {
      if (!rel.to.includes('/') && !rel.to.includes('.py')) {
        external.add(rel.to);
      }
    });

    // Internal dependencies
    const internal = importRelations
      .filter(rel => rel.to.includes('/') || rel.to.includes('.py'))
      .map(rel => ({ from: rel.from, to: rel.to }))
      .slice(0, 20); // Limit to key internal deps

    return {
      external: Array.from(external).slice(0, 20),
      internal
    };
  }

  private _extractKeyRelations(relations: Relation[]) {
    const inheritance = relations
      .filter(r => r.relationType === 'inherits')
      .map(r => ({ from: r.from, to: r.to }));

    const keyUsages = relations
      .filter(r => ['calls', 'uses', 'implements'].includes(r.relationType))
      .slice(0, 30) // Limit for token management
      .map(r => ({ from: r.from, to: r.to, type: r.relationType }));

    return { inheritance, keyUsages };
  }

  async getEntitySpecificGraph(entityName: string, mode: 'smart' | 'entities' | 'relationships' | 'raw' = 'smart', limit?: number): Promise<any> {
    await this.connect();
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    // Step 1: Check if target entity exists
    const targetEntityResults = await this.client.search(COLLECTION_NAME, {
      vector: {
        name: 'dense',
        vector: new Array(this.vectorSize).fill(0) // Dummy vector for filter-only search
      },
      limit: 1,
      with_payload: true,
      filter: {
        must: [
          { key: "entity_name", match: { value: entityName } },
          { key: "chunk_type", match: { value: "metadata" } }
        ]
      }
    });

    if (targetEntityResults.length === 0) {
      throw new Error(`Entity '${entityName}' not found`);
    }

    // Step 2: Find all relations involving this entity
    const relatedRelations = await this.scrollRelationsForEntity(entityName);

    // Step 3: Collect all related entity names
    const relatedEntityNames = new Set<string>();
    relatedEntityNames.add(entityName); // Include the target entity

    relatedRelations.forEach(rel => {
      relatedEntityNames.add(rel.from);
      relatedEntityNames.add(rel.to);
    });

    // Step 4: Fetch entity details for all related entities
    const entities = await this.fetchEntitiesByNames(Array.from(relatedEntityNames), limit);

    // Step 5: Apply mode-specific formatting
    switch (mode) {
      case "smart":
        return this.formatSmartEntityGraph(targetEntityResults[0], entities, relatedRelations);
      case "entities":
        return { entities, relations: relatedRelations };
      case "relationships":
        return { entities, relations: relatedRelations };
      case "raw":
        return { entities, relations: relatedRelations };
      default:
        return { entities, relations: relatedRelations };
    }
  }

  private async scrollRelationsForEntity(entityName: string): Promise<Relation[]> {
    const relations: Relation[] = [];
    let offset: string | number | undefined = undefined;
    const batchSize = 100;

    do {
      const scrollResult = await this.client.scroll(COLLECTION_NAME!, {
        limit: batchSize,
        offset,
        with_payload: true,
        with_vector: false,
        filter: {
          must: [
            { key: "type", match: { value: "chunk" } },
            { key: "chunk_type", match: { value: "relation" } },
            {
              should: [
                { key: "entity_name", match: { value: entityName } },
                { key: "relation_target", match: { value: entityName } }
              ]
            }
          ]
        }
      });

      for (const point of scrollResult.points) {
        if (!point.payload) continue;
        const payload = point.payload as unknown as ChunkPayload;

        if (isRelationChunk(payload)) {
          relations.push({
            from: payload.entity_name!,
            to: payload.relation_target!,
            relationType: payload.relation_type!
          });
        }
      }

      offset = (typeof scrollResult.next_page_offset === 'string' || typeof scrollResult.next_page_offset === 'number') 
        ? scrollResult.next_page_offset 
        : undefined;
    } while (offset !== null && offset !== undefined);

    return relations;
  }

  private async fetchEntitiesByNames(names: string[], limit?: number): Promise<Entity[]> {
    const entities: Entity[] = [];
    // Token-aware limit: balance between comprehensive data and token constraints
    // Based on memory analysis: entities mode can handle ~300, smart mode ~150
    const tokenAwareLimit = limit || Math.min(names.length, 400);
    
    // Build OR filter for all entity names
    const results = await this.client.search(COLLECTION_NAME!, {
      vector: {
        name: 'dense',
        vector: new Array(this.vectorSize).fill(0) // Dummy vector for filter-only search
      },
      limit: tokenAwareLimit, // Token-aware limit instead of hardcoded 1000
      with_payload: true,
      filter: {
        must: [
          { key: "chunk_type", match: { value: "metadata" } }
        ],
        should: names.map(name => ({
          key: "entity_name",
          match: { value: name }
        }))
      }
    });

    for (const result of results) {
      if (!result.payload) continue;
      const payload = result.payload as unknown as ChunkPayload;

      if (isMetadataChunk(payload)) {
        // Extract entity_type from metadata (new format) or fallback to top-level (backward compatibility)
        const entityType = (payload as any).metadata?.entity_type || payload.entity_type;
        entities.push({
          name: payload.entity_name,
          entityType: entityType,
          observations: (payload as any).observations || (payload as any).metadata?.observations || []
        });
      }
    }

    return entities;
  }

  private filterRelationsByEntityTypes(relations: Relation[], allEntities: Entity[], entityTypes?: string[]): Relation[] {
    if (!entityTypes || entityTypes.length === 0) return relations;
    
    // Exclude chunk types from entityTypes filtering
    const knownChunkTypes = ["metadata", "implementation"];
    const actualEntityTypes = entityTypes.filter(type => !knownChunkTypes.includes(type));
    
    if (actualEntityTypes.length === 0) return relations;
    
    const entityTypeMap = new Map();
    allEntities.forEach(entity => entityTypeMap.set(entity.name, entity.entityType));
    
    console.error(`[MCP DEBUG] Filtering ${relations.length} relations by entity types: ${actualEntityTypes.join(', ')}`);
    
    const filtered = relations.filter(relation => {
      const fromType = entityTypeMap.get(relation.from);
      const toType = entityTypeMap.get(relation.to);
      return actualEntityTypes.includes(fromType) || actualEntityTypes.includes(toType);
    });
    
    console.error(`[MCP DEBUG] Filtered to ${filtered.length} relations involving specified entity types`);
    return filtered;
  }

  private filterRelationsForEntities(relations: Relation[], entities: Entity[]): Relation[] {
    // Create set of entity names for fast lookup
    const entityNames = new Set(entities.map(e => e.name));
    console.error(`[MCP DEBUG] Filtering ${relations.length} relations for ${entities.length} entities`);
    console.error(`[MCP DEBUG] Entity names:`, Array.from(entityNames).slice(0, 5));
    
    // Only include relations where from OR to entity is in our filtered set
    const filtered = relations.filter(relation => {
      const matches = entityNames.has(relation.from) || entityNames.has(relation.to);
      return matches;
    });
    
    console.error(`[MCP DEBUG] Filtered to ${filtered.length} relevant relations`);
    return filtered;
  }

  private formatSmartEntityGraph(targetResult: any, relatedEntities: Entity[], relationships: Relation[]): any {
    // Extract entity_type from metadata (new format) or fallback to top-level (backward compatibility)
    const entityType = targetResult.payload.metadata?.entity_type || targetResult.payload.entity_type;
    const targetEntity = {
      name: targetResult.payload.entity_name,
      type: entityType,
      file: targetResult.payload.metadata?.file_path || 'unknown'
    };

    // Group entities by type
    const entityGroups: Record<string, number> = {};
    relatedEntities.forEach(entity => {
      entityGroups[entity.entityType] = (entityGroups[entity.entityType] || 0) + 1;
    });

    // Count relationship directions
    const incoming = relationships.filter(r => r.to === targetEntity.name).length;
    const outgoing = relationships.filter(r => r.from === targetEntity.name).length;

    // Summarize key relationships
    const keyRelationships = this.summarizeKeyRelationships(relationships, targetEntity.name);

    return {
      summary: {
        target: targetEntity,
        stats: {
          total_connections: relationships.length,
          incoming,
          outgoing,
          entity_types: Object.entries(entityGroups).map(([type, count]) => ({
            type,
            count
          }))
        },
        key_relationships: keyRelationships
      },
      entities: relatedEntities.slice(0, 10), // Limit for readability
      relations: relationships.slice(0, 50) // Limit for token management
    };
  }

  private summarizeKeyRelationships(relationships: Relation[], entityName: string): any {
    const outgoing = relationships
      .filter(r => r.from === entityName)
      .reduce((acc, r) => {
        acc[r.relationType] = (acc[r.relationType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

    const incoming = relationships
      .filter(r => r.to === entityName)
      .reduce((acc, r) => {
        acc[r.relationType] = (acc[r.relationType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

    return { outgoing, incoming };
  }

  async getMetadataChunks(limit: number = 10000): Promise<any[]> {
    await this.initialize();
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    const chunks: any[] = [];
    let offset: string | number | undefined = undefined;
    const batchSize = 100;
    let collected = 0;
    let batchCount = 0;

    console.error(`[DEBUG] Starting getMetadataChunks with limit=${limit}`);

    do {
      batchCount++;
      console.error(`[DEBUG] Batch ${batchCount}: offset=${offset}, collected=${collected}`);
      
      const scrollResult = await this.client.scroll(COLLECTION_NAME, {
        limit: Math.min(batchSize, limit - collected),
        offset,
        with_payload: true,
        with_vector: false,
        filter: {
          must: [
            { key: 'chunk_type', match: { value: 'metadata' } }
          ]
        }
      });

      console.error(`[DEBUG] Batch ${batchCount}: got ${scrollResult.points.length} points, next_offset=${scrollResult.next_page_offset}`);
      console.error(`[DEBUG] Batch ${batchCount}: next_offset type=${typeof scrollResult.next_page_offset}, value=${scrollResult.next_page_offset}`);

      for (const point of scrollResult.points) {
        if (point.payload && collected < limit) {
          chunks.push(point.payload);
          collected++;
        }
      }

      // Handle all valid offset types (string, number, bigint)
      offset = scrollResult.next_page_offset !== null && scrollResult.next_page_offset !== undefined 
        ? scrollResult.next_page_offset as string | number
        : undefined;
        
      console.error(`[DEBUG] Batch ${batchCount}: collected=${collected}, next_offset=${offset}`);
      
      // Safety check to prevent infinite loop
      if (batchCount > 50) {
        console.error(`[DEBUG] SAFETY BREAK: Stopping after 50 batches`);
        break;
      }
    } while (offset !== null && offset !== undefined && collected < limit);

    console.error(`BM25 index initialized with ${chunks.length} metadata chunks`);
    console.error(`[DEBUG] Final stats: ${batchCount} batches, ${collected} collected, last_offset=${offset}`);
    return chunks;
  }
}
// Test modification at Tue Jul 15 23:09:50 CEST 2025
