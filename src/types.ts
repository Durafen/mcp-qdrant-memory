export interface Entity extends Record<string, unknown> {
  name: string;
  entityType: string;
  observations: string[];
}

export interface Relation extends Record<string, unknown> {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

export interface EntityChunk extends Record<string, unknown> {
  id: string;
  entity_name: string;
  entity_type: string;
  chunk_type: 'metadata' | 'implementation';
  content: string;
  content_hash?: string;
  file_path?: string;
  line_number?: number;
  has_implementation?: boolean;
}

export interface SearchResult {
  type: 'chunk';
  score: number;
  data: EntityChunk;
}

export interface SmartGraph {
  summary: {
    totalEntities: number;
    totalRelations: number;
    breakdown: Record<string, number>; // { "class": 45, "function": 198, ... }
    keyModules: string[]; // Top-level directories/packages
    timestamp: string;
  };
  structure: {
    // Hierarchical file tree with entity counts
    [path: string]: {
      type: 'file' | 'directory';
      entities: number;
      children?: Record<string, any>;
    };
  };
  apiSurface: {
    classes: Array<{
      name: string;
      file: string;
      line: number;
      docstring?: string;
      methods: string[]; // Just names
      inherits?: string[];
    }>;
    functions: Array<{
      name: string;
      file: string;
      line: number;
      signature?: string;
      docstring?: string;
    }>;
  };
  dependencies: {
    external: string[]; // External package imports
    internal: Array<{ from: string; to: string }>; // Key internal dependencies
  };
  relations: {
    inheritance: Array<{ from: string; to: string }>;
    keyUsages: Array<{ from: string; to: string; type: string }>;
  };
}

export interface ScrollOptions {
  entityTypes?: string[];
  limit?: number;
  mode?: 'smart' | 'entities' | 'relationships' | 'raw';
}

export interface StreamingGraphResponse {
  content: SmartGraph | KnowledgeGraph;
  meta: {
    tokenCount: number;
    tokenLimit: number;
    truncated: boolean;
    truncationReason?: string;
    sectionsIncluded: string[];
  };
}

export interface TokenBudget {
  total: number;
  used: number;
  remaining: number;
}

export interface ContentSection {
  name: string;
  content: any;
  tokenCount: number;
  priority: number;
}

export interface SemanticMetadata {
  calls: string[];
  imports_used: string[];
  file_path?: string;
  exceptions_handled?: string[];
  complexity?: number;
  inferred_types?: string[];
}