#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();

// Console override temporarily disabled - breaks MCP server startup
// import { overrideConsoleForMCP } from './console-override.js';
// overrideConsoleForMCP();

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
// import { promises as fs } from 'fs'; // Removed: No longer using file system for JSON storage
// import path from 'path'; // Removed: No longer needed for file paths
// import { fileURLToPath } from 'url'; // Removed: No longer needed for file paths
import { QdrantPersistence } from './persistence/qdrant.js';
import { Entity, Relation, KnowledgeGraph, SmartGraph, ScrollOptions, StreamingGraphResponse, SearchResult } from './types.js';
import { streamingResponseBuilder } from './streamingResponseBuilder.js';
import { tokenCounter, TOKEN_CONFIG } from './tokenCounter.js';
import { COLLECTION_NAME } from './config.js';
import {
  validateCreateEntitiesRequest,
  validateCreateRelationsRequest,
  validateAddObservationsRequest,
  validateDeleteEntitiesRequest,
  validateDeleteObservationsRequest,
  validateDeleteRelationsRequest,
  validateSearchSimilarRequest,
  validateGetImplementationRequest,
} from './validation.js';

// Removed: Path definitions no longer needed since we're not writing JSON files

class KnowledgeGraphManager {
  private qdrant: QdrantPersistence;

  constructor() {
    this.qdrant = new QdrantPersistence();
  }

  async initialize(): Promise<void> {
    // Initialize Qdrant - it's the sole source of truth
    await this.qdrant.initialize();
  }

  // async save(): Promise<void> {
  //   await fs.writeFile(MEMORY_FILE_PATH, JSON.stringify(this.graph, null, 2));
  // } // Removed: JSON file writing disabled

  async addEntities(entities: Entity[]): Promise<void> {
    for (const entity of entities) {
      // Since we're using Qdrant as the sole source of truth, just persist
      await this.qdrant.persistEntity(entity);
    }
    // await this.save(); // Removed: JSON file writing disabled
  }

  async addRelations(relations: Relation[]): Promise<void> {
    // Load current entities from Qdrant for validation with unlimited limit
    const currentGraph = await this.getRawGraph(Number.MAX_SAFE_INTEGER);
    
    for (const relation of relations) {
      if (!currentGraph.entities.some(e => e.name === relation.from)) {
        throw new Error(`Entity not found: ${relation.from}`);
      }
      if (!currentGraph.entities.some(e => e.name === relation.to)) {
        throw new Error(`Entity not found: ${relation.to}`);
      }
      
      // Since we're using Qdrant as the sole source of truth, just persist
      await this.qdrant.persistRelation(relation);
    }
    // await this.save(); // Removed: JSON file writing disabled
  }

  async addObservations(entityName: string, observations: string[]): Promise<void> {
    // Load current entities from Qdrant with unlimited limit for entity lookups
    const currentGraph = await this.getRawGraph(Number.MAX_SAFE_INTEGER);
    const entity = currentGraph.entities.find((e: Entity) => e.name === entityName);
    if (!entity) {
      throw new Error(`Entity not found: ${entityName}`);
    }
    (entity.observations || []).push(...observations);
    await this.qdrant.persistEntity(entity);
    // await this.save(); // Removed: JSON file writing disabled
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    // Load current graph to find related relations with unlimited limit
    const currentGraph = await this.getRawGraph(Number.MAX_SAFE_INTEGER);
    
    for (const name of entityNames) {
      // Delete the entity
      await this.qdrant.deleteEntity(name);
      
      // Delete all relations involving this entity
      const relatedRelations = currentGraph.relations.filter(
        (r: Relation) => r.from === name || r.to === name
      );
      for (const relation of relatedRelations) {
        await this.qdrant.deleteRelation(relation);
      }
    }
    // await this.save(); // Removed: JSON file writing disabled
  }

  async deleteObservations(entityName: string, observations: string[]): Promise<void> {
    // Load current entities from Qdrant with unlimited limit for entity lookups
    const currentGraph = await this.getRawGraph(Number.MAX_SAFE_INTEGER);
    const entity = currentGraph.entities.find((e: Entity) => e.name === entityName);
    if (!entity) {
      throw new Error(`Entity not found: ${entityName}`);
    }
    entity.observations = (entity.observations || []).filter((o: string) => !observations.includes(o));
    await this.qdrant.persistEntity(entity);
    // await this.save(); // Removed: JSON file writing disabled
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    for (const relation of relations) {
      // Since we're using Qdrant as the sole source of truth, just delete
      await this.qdrant.deleteRelation(relation);
    }
    // await this.save(); // Removed: JSON file writing disabled
  }

  async getGraph(options?: ScrollOptions): Promise<KnowledgeGraph | SmartGraph> {
    try {
      return await this.qdrant.scrollAll(options);
    } catch (error) {
      console.error('Failed to read from Qdrant:', error);
      // Return empty graph on error
      return { entities: [], relations: [] };
    }
  }

  async getRawGraph(limit?: number, entityTypes?: string[], mode: 'smart' | 'entities' | 'relationships' | 'raw' = 'raw'): Promise<KnowledgeGraph> {
    try {
      // Get limited raw entities and relations from Qdrant for streaming processing
      const rawData = await this.qdrant.scrollAll({ mode, limit, entityTypes });
      if ('entities' in rawData && 'relations' in rawData) {
        return rawData as KnowledgeGraph;
      }
      // If it's not a KnowledgeGraph (e.g., SmartGraph), return empty
      return { entities: [], relations: [] };
    } catch (error) {
      console.error('Failed to read raw graph from Qdrant:', error);
      return { entities: [], relations: [] };
    }
  }

  async searchSimilar(query: string, entityTypes?: string[], limit: number = 20): Promise<SearchResult[]> {
    // Ensure limit is a positive number, no hard cap
    const validLimit = Math.max(1, limit);
    return await this.qdrant.searchSimilar(query, entityTypes, validLimit);
  }

  async getImplementation(entityName: string, scope: 'minimal' | 'logical' | 'dependencies' = 'minimal', limit?: number): Promise<SearchResult[]> {
    return await this.qdrant.getImplementationChunks(entityName, scope, limit);
  }

  async getEntitySpecificGraph(entityName: string, mode: 'smart' | 'entities' | 'relationships' | 'raw' = 'smart', limit?: number): Promise<any> {
    return await this.qdrant.getEntitySpecificGraph(entityName, mode, limit);
  }
}

interface CallToolRequest {
  params: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}

class MemoryServer {
  private server: Server;
  private graphManager: KnowledgeGraphManager;

  constructor() {
    this.server = new Server(
      {
        name: "memory",
        version: "0.6.3",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.graphManager = new KnowledgeGraphManager();
    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "create_entities",
          description: "Create multiple new entities in the knowledge graph",
          inputSchema: {
            type: "object",
            properties: {
              entities: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    entityType: { type: "string" },
                    observations: {
                      type: "array",
                      items: { type: "string" }
                    }
                  },
                  required: ["name", "entityType", "observations"]
                }
              }
            },
            required: ["entities"]
          }
        },
        {
          name: "create_relations",
          description: "Create multiple new relations between entities",
          inputSchema: {
            type: "object",
            properties: {
              relations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    from: { type: "string" },
                    to: { type: "string" },
                    relationType: { type: "string" }
                  },
                  required: ["from", "to", "relationType"]
                }
              }
            },
            required: ["relations"]
          }
        },
        {
          name: "add_observations",
          description: "Add new observations to existing entities",
          inputSchema: {
            type: "object",
            properties: {
              observations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    entityName: { type: "string" },
                    contents: {
                      type: "array",
                      items: { type: "string" }
                    }
                  },
                  required: ["entityName", "contents"]
                }
              }
            },
            required: ["observations"]
          }
        },
        {
          name: "delete_entities",
          description: "Delete multiple entities and their relations",
          inputSchema: {
            type: "object",
            properties: {
              entityNames: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: ["entityNames"]
          }
        },
        {
          name: "delete_observations",
          description: "Delete specific observations from entities",
          inputSchema: {
            type: "object",
            properties: {
              deletions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    entityName: { type: "string" },
                    observations: {
                      type: "array",
                      items: { type: "string" }
                    }
                  },
                  required: ["entityName", "observations"]
                }
              }
            },
            required: ["deletions"]
          }
        },
        {
          name: "delete_relations",
          description: "Delete multiple relations",
          inputSchema: {
            type: "object",
            properties: {
              relations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    from: { type: "string" },
                    to: { type: "string" },
                    relationType: { type: "string" }
                  },
                  required: ["from", "to", "relationType"]
                }
              }
            },
            required: ["relations"]
          }
        },
        {
          name: "read_graph",
          description: "Read filtered knowledge graph with smart summarization",
          inputSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                enum: ["smart", "entities", "relationships", "raw"],
                description: "smart: AI-optimized view (default), entities: filtered entities, relationships: connection focus, raw: full graph (may exceed limits)",
                default: "smart"
              },
              entityTypes: {
                type: "array",
                items: { type: "string" },
                description: "Filter specific entity types (e.g., ['class', 'function'])"
              },
              entity: {
                type: "string",
                description: "Optional: Specific entity name to center the graph around"
              },
              limit: {
                type: "number",
                description: "Max entities per type (default: 150)",
                default: 150
              }
            }
          }
        },
        {
          name: "search_similar",
          description: "Search for similar entities and relations using semantic search with progressive disclosure support",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              entityTypes: {
                type: "array",
                items: { type: "string" },
                description: "Filter by entity types: class, function, file, documentation, debugging_pattern, etc."
              },
              limit: { 
                type: "number",
                default: 20
              }
            },
            required: ["query"]
          }
        },
        {
          name: "get_implementation",
          description: "Retrieve implementation with semantic scope control",
          inputSchema: {
            type: "object",
            properties: {
              entityName: { 
                type: "string",
                description: "Name of the entity to retrieve"
              },
              scope: {
                type: "string",
                enum: ["minimal", "logical", "dependencies"],
                default: "minimal",
                description: "Scope of related code to include: minimal (entity only), logical (same-file helpers), dependencies (imports and calls)"
              }
            },
            required: ["entityName"]
          }
        }
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
      if (!request.params.arguments) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing arguments"
        );
      }

      try {
        let response: any;
        
        switch (request.params.name) {
          case "create_entities": {
            const args = validateCreateEntitiesRequest(request.params.arguments);
            await this.graphManager.addEntities(args.entities);
            response = {
              content: [{ type: "text", text: "Entities created successfully" }],
            };
            return response;
          }

          case "create_relations": {
            const args = validateCreateRelationsRequest(request.params.arguments);
            await this.graphManager.addRelations(args.relations);
            return {
              content: [{ type: "text", text: "Relations created successfully" }],
            };
          }

          case "add_observations": {
            const args = validateAddObservationsRequest(request.params.arguments);
            for (const obs of args.observations) {
              await this.graphManager.addObservations(obs.entityName, obs.contents);
            }
            return {
              content: [{ type: "text", text: "Observations added successfully" }],
            };
          }

          case "delete_entities": {
            const args = validateDeleteEntitiesRequest(request.params.arguments);
            await this.graphManager.deleteEntities(args.entityNames);
            return {
              content: [{ type: "text", text: "Entities deleted successfully" }],
            };
          }

          case "delete_observations": {
            const args = validateDeleteObservationsRequest(request.params.arguments);
            for (const del of args.deletions) {
              await this.graphManager.deleteObservations(del.entityName, del.observations);
            }
            return {
              content: [{ type: "text", text: "Observations deleted successfully" }],
            };
          }

          case "delete_relations": {
            const args = validateDeleteRelationsRequest(request.params.arguments);
            await this.graphManager.deleteRelations(args.relations);
            return {
              content: [{ type: "text", text: "Relations deleted successfully" }],
            };
          }

          case "read_graph": {
            const mode = (request.params.arguments?.mode as 'smart' | 'entities' | 'relationships' | 'raw') || 'smart';
            const entityTypes = request.params.arguments?.entityTypes as string[] | undefined;
            const entity = request.params.arguments?.entity as string | undefined;
            const limit = (request.params.arguments?.limit as number) || 150;
            
            
            // Handle entity-specific graph
            if (entity) {
              const entityGraph = await this.graphManager.getEntitySpecificGraph(entity, mode, limit);
              // Use full streaming response for entity-specific graphs to handle smart mode token management
              const options: ScrollOptions = { mode, entityTypes, limit };
              // Auto-cut: Exponential backoff if response exceeds 25k tokens
              let finalResponse = await this.autoReduceResponse(
                async (tryLimit: number) => {
                  const entityGraph = await this.graphManager.getEntitySpecificGraph(entity, mode, tryLimit);
                  const options: ScrollOptions = { mode, entityTypes, limit: tryLimit };
                  return await streamingResponseBuilder.buildStreamingResponse(
                    entityGraph.entities || [],
                    entityGraph.relations || [],
                    options
                  );
                },
                limit
              );
              
              const fullResponse = JSON.stringify(finalResponse);
              
              return {
                content: [
                  {
                    type: "text",
                    text: fullResponse,
                  },
                ],
              };
            }
            
            // Handle general graph (existing logic)
            const options: ScrollOptions = {
              mode,
              entityTypes,
              limit
            };
            
            // Auto-cut: Exponential backoff if response exceeds 25k tokens
            const finalResponse = await this.autoReduceResponse(
              async (tryLimit: number) => {
                const rawGraph = await this.graphManager.getRawGraph(tryLimit, entityTypes, mode);
                const options: ScrollOptions = { mode, entityTypes, limit: tryLimit };
                return await streamingResponseBuilder.buildStreamingResponse(
                  rawGraph.entities,
                  rawGraph.relations,
                  options
                );
              },
              limit
            );
            
            const fullResponse = JSON.stringify(finalResponse);
            
            return {
              content: [
                {
                  type: "text",
                  text: fullResponse,
                },
              ],
            };
          }

          case "search_similar": {
            const args = validateSearchSimilarRequest(request.params.arguments);
            
            // Auto-reduce if response exceeds token limits
            const finalResponse = await this.autoReduceResponse(
              async (tryLimit: number) => {
                const results = await this.graphManager.searchSimilar(
                  args.query,
                  args.entityTypes,
                  tryLimit
                );
                return await streamingResponseBuilder.buildGenericStreamingResponse(results, TOKEN_CONFIG.DEFAULT_TOKEN_LIMIT);
              },
              args.limit || 20
            );
            
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(finalResponse),
                },
              ],
            };
          }

          case "get_implementation": {
            const args = validateGetImplementationRequest(request.params.arguments);
            
            // Auto-reduce if response exceeds token limits
            // Start with actual scope limits from Qdrant persistence
            const scopeLimits = {
              'minimal': 50,      // No specific limit for minimal
              'logical': 20,      // From memory: logical scope limit
              'dependencies': 20  // From memory: dependencies scope limit
            };
            const initialLimit = scopeLimits[args.scope || 'minimal'];
            
            const finalResponse = await this.autoReduceResponse(
              async (tryLimit: number) => {
                // Need to pass the limit through to the implementation
                const results = await this.graphManager.getImplementation(args.entityName, args.scope, tryLimit);
                return await streamingResponseBuilder.buildGenericStreamingResponse(results);
              },
              initialLimit
            );
            
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(finalResponse),
                },
              ],
            };
          }

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
        
        // Ensure response never exceeds token limits
        if (response && response.content && response.content[0] && response.content[0].text) {
          const maxTokens = 24000; // Conservative limit to stay under 25k
          const originalText = response.content[0].text;
          const limitedText = tokenCounter.serializeWithMaxUtilization(originalText, maxTokens);
          response.content[0].text = limitedText;
        }
        
        return response;
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : String(error)
        );
      }
    });
  }

  /**
   * Auto-reduce response size using exponential backoff when exceeding token limits
   */
  private async autoReduceResponse(
    buildFunction: (limit: number) => Promise<any>,
    initialLimit: number
  ): Promise<any> {
    const maxAttempts = 10;
    const reductionFactor = 0.7;
    const tokenLimit = TOKEN_CONFIG.DEFAULT_TOKEN_LIMIT; // Use consistent 23k limit
    
    let currentLimit = initialLimit;
    let attempts = 0;
    
    console.error(`[DEBUG] autoReduceResponse starting with initialLimit: ${initialLimit}`);
    
    while (attempts < maxAttempts) {
      try {
        const response = await buildFunction(currentLimit);
        const responseText = JSON.stringify(response);
        const tokenCount = Math.ceil(responseText.length / 4);
        
        console.error(`[DEBUG] Attempt ${attempts + 1}: limit=${currentLimit}, response size=${responseText.length} chars, tokens=${tokenCount}`);
        
        // If response fits within token limit, return it
        if (tokenCount <= tokenLimit) {
          console.error(`[DEBUG] Response fits within token limit, returning`);
          return response;
        }
        
        // If this was our last attempt, let MCP handle the overflow
        if (attempts === maxAttempts - 1) {
          console.error(`[ERROR] Auto-reduce failed after ${attempts + 1} attempts. Final response: ${tokenCount} tokens. Letting MCP handle overflow.`);
          console.error(`[ERROR] This will cause MCP tool response to exceed 25000 token limit!`);
          // Return what we can with final reduced limit
          console.error(`[DEBUG] Using buildGenericStreamingResponse to fit within token limit`);
          const finalResponse = await buildFunction(1); // Get minimal results
          return await streamingResponseBuilder.buildGenericStreamingResponse(
            finalResponse.content || [], 
            tokenLimit
          );
        }
        
        // Reduce limit and try again
        currentLimit = Math.max(1, Math.floor(currentLimit * reductionFactor));
        console.error(`[DEBUG] Reducing limit for next attempt: ${currentLimit}`);
        attempts++;
        
      } catch (error) {
        console.error(`Auto-reduce attempt ${attempts + 1} failed:`, error);
        // Return minimal valid response on error
        return {
          content: [],
          meta: {
            tokenCount: 0,
            tokenLimit: tokenLimit,
            truncated: true,
            error: `Auto-reduce error: ${error}`,
            sectionsIncluded: [],
            autoReduceAttempts: attempts + 1
          }
        };
      }
    }
    
    // Should never reach here, but fallback
    return {
      content: { entities: [], relations: [] },
      meta: {
        tokenCount: 0,
        tokenLimit: 24480,
        truncated: true,
        truncationReason: "Auto-reduce exhausted all attempts",
        sectionsIncluded: [],
        autoReduceAttempts: maxAttempts
      }
    };
  }

  async run() {
    try {
      await this.graphManager.initialize();
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error("Memory MCP server running on stdio");
    } catch (error) {
      console.error("Fatal error running server:", error);
      process.exit(1);
    }
  }
}

// Server startup
const server = new MemoryServer();
server.run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});