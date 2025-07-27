# MCP Memory Server with Qdrant Persistence (Enhanced for Claude Code)
[![smithery badge](https://smithery.ai/badge/@delorenj/mcp-qdrant-memory)](https://smithery.ai/server/@delorenj/mcp-qdrant-memory)

This MCP server provides a knowledge graph implementation with semantic search capabilities powered by Qdrant vector database. **Enhanced version** with direct Qdrant integration for Claude Code memory solution.

## 🎯 Latest Enhancements - v2.4 Production Ready ✅

- **🚀 Auto-Reduce Token Management**: Exponential backoff with 0.7 reduction factor (10 max attempts)  
- **🎯 25k Token Compliance**: Intelligent token limiting with 96% safety margin for maximum utilization
- **⚡ Progressive Disclosure**: `search_similar` returns metadata-first for 90% faster queries
- **🎯 Entity-Specific Filtering**: NEW `entity` parameter focuses on individual components (10-20 relations vs 300+)
- **🧠 Smart Entity Analysis**: AI-powered summaries with connection stats and relationship breakdowns  
- **🔧 4 Targeted Modes**: smart (AI overview), entities (connections), relationships (relations only), raw (complete)
- **⚡ Laser-Focused Debugging**: Eliminate information overload with precise entity-centered queries
- **🛡️ Error Handling**: Clear feedback for non-existent entities with helpful error messages
- **🎯 Semantic Scope Implementation**: `get_implementation(entityName, scope?)` with contextual code retrieval
  - **`minimal`**: Just the entity implementation (default, backward compatible)
  - **`logical`**: Entity + helper functions/classes from same file (analyzes calls + `_` prefixed helpers)
  - **`dependencies`**: Entity + imported modules and called functions (cross-file relationships)
- **🧠 Smart Metadata Usage**: Leverages structured semantic metadata from indexing process
- **⚡ Performance Optimized**: Configurable limits (20 logical, 30 dependencies) with smart deduplication
- **🎯 Automatic Provider Detection**: Reads embedding provider from environment variables
- **🚀 Voyage AI Integration**: Built-in support for voyage-3-lite with cost optimization
- **🛡️ Backward Compatibility**: Seamlessly handles both v2.3 and v2.4 chunk formats, plus general graph calls
- **📊 Structured Responses**: Summary, API surface, dependencies, and file structure
- **🔄 Direct Qdrant Integration**: Works seamlessly with claude-indexer direct writes
- **📈 Large Collection Support**: Handles 2000+ vectors efficiently via scroll API
- **🔧 Streaming Response Builder**: Progressive content building with section priorities and token enforcement
- **📏 Industry-Standard Token Counting**: Character-based approximation (chars/4) with intelligent truncation

## Features

- Graph-based knowledge representation with entities and relations
- **Dual persistence**: Qdrant vector database + JSON file fallback
- Semantic search using Qdrant vector database
- OpenAI embeddings for semantic similarity
- HTTPS support with reverse proxy compatibility
- Docker support for easy deployment
- **Enhanced read_graph**: Direct database reads with automatic fallback

## Environment Variables

The following environment variables are required:

```bash
# Embedding Provider Configuration (v2.4)
# OpenAI API key (default provider)
OPENAI_API_KEY=your-openai-api-key

# Voyage AI API key (recommended - 85% cost reduction)
VOYAGE_API_KEY=your-voyage-key
EMBEDDING_PROVIDER=voyage
EMBEDDING_MODEL=voyage-3-lite

# Qdrant server URL (supports both HTTP and HTTPS)
QDRANT_URL=https://your-qdrant-server

# Qdrant API key (if authentication is enabled)
QDRANT_API_KEY=your-qdrant-api-key

# Name of the Qdrant collection to use
QDRANT_COLLECTION_NAME=your-collection-name
```

## Setup

### Local Setup

1. Install dependencies:
```bash
npm install
```

2. Build the server:
```bash
npm run build
```

### Docker Setup

1. Build the Docker image:
```bash
docker build -t mcp-qdrant-memory .
```

2. Run the Docker container with required environment variables:
```bash
docker run -d \
  -e OPENAI_API_KEY=your-openai-api-key \
  -e QDRANT_URL=http://your-qdrant-server:6333 \
  -e QDRANT_COLLECTION_NAME=your-collection-name \
  -e QDRANT_API_KEY=your-qdrant-api-key \
  --name mcp-qdrant-memory \
  mcp-qdrant-memory
```

### Add to MCP settings:
```json
{
  "mcpServers": {
    "memory": {
      "command": "/bin/zsh",
      "args": ["-c", "cd /path/to/server && node dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "your-openai-api-key",
        "QDRANT_API_KEY": "your-qdrant-api-key",
        "QDRANT_URL": "http://your-qdrant-server:6333",
        "QDRANT_COLLECTION_NAME": "your-collection-name"
      },
      "alwaysAllow": [
        "create_entities",
        "create_relations",
        "add_observations",
        "delete_entities",
        "delete_observations",
        "delete_relations",
        "read_graph",
        "search_similar",
        "get_implementation"
      ]
    }
  }
}
```

## Tools

### Entity Management
- `create_entities`: Create multiple new entities with observations array
- `create_relations`: Create relations between entities  
- `add_observations`: Add observation strings to existing entities (stored as string array)
- `delete_entities`: Delete entities and their relations
- `delete_observations`: Delete specific observations from entities
- `delete_relations`: Delete specific relations
- `read_graph`: **Enhanced** - Get smart, filtered knowledge graph with NEW entity-specific filtering

### Progressive Disclosure Search (v2.4)
- `search_similar`: **Enhanced** - Hybrid search by default with metadata-first approach for optimal code discovery
  ```typescript
  interface SearchParams {
    query: string;           // Search query text
    entityTypes?: string[];  // Unified filtering: entity types (class, function, documentation, text_chunk) + chunk types (metadata, implementation)
    limit?: number;          // Max results (default: 50)
    searchMode?: string;     // Search mode: "semantic", "keyword", "hybrid" (default: "hybrid")
  }
  
  // Search Modes:
  // "semantic": Dense vector search for conceptual understanding (0.6-0.8 scores)
  // "keyword": BM25 sparse vector search for exact term matching (1.5+ scores)  
  // "hybrid": Combined 70% semantic + 30% keyword for balanced results (0.4-1.2 scores)
  
  // Unified entityTypes parameter supports:
  // Entity Types: ["class", "function", "documentation", "text_chunk"]
  // Chunk Types: ["metadata", "implementation"]  
  // Mixed Arrays: ["function", "metadata", "implementation"] (OR logic)
  ```

- `get_implementation`: **ENHANCED** - Semantic scope implementation access (v2.4.1)
  ```typescript
  interface ImplementationParams {
    entityName: string;              // Name of entity to get implementation details for
    scope?: 'minimal' | 'logical' | 'dependencies';  // Scope of related code (default: 'minimal')
  }
  ```
  
  **Scope Types:**
  - **`minimal`** (default): Returns only the requested entity's implementation
  - **`logical`**: Returns entity + helper functions/classes from same file (analyzes calls + `_` prefixed helpers)
  - **`dependencies`**: Returns entity + imported modules and called functions (cross-file relationships)
  
  **Usage Examples:**
  ```typescript
  // Get just the parseAST function implementation
  await get_implementation("parseAST")
  
  // Get parseAST + its same-file helpers (_extract_nodes, _validate_syntax)
  await get_implementation("parseAST", "logical")
  
  // Get parseAST + external dependencies (TreeSitter.parse, ast.walk, etc.)
  await get_implementation("parseAST", "dependencies")
  ```

## Implementation Details

The server maintains enhanced dual storage with Qdrant as primary:

1. **Qdrant Vector DB (Primary)**:
   - Semantic embeddings of entities and relations
   - Complete knowledge graph storage
   - **Enhanced read_graph**: Direct database reads via scroll API
   - Handles large collections (2000+ vectors) efficiently

2. **File-based (memory.json - Fallback)**:
   - Local knowledge graph cache
   - Fast fallback when Qdrant unavailable
   - Maintains backward compatibility

### ✨ Enhanced Synchronization

**Direct Qdrant Mode** (claude-indexer integration):
1. Entities written directly to Qdrant
2. **read_graph** reads from Qdrant database
3. JSON file may be empty (fallback only)
4. Supports large-scale knowledge graphs

**Traditional MCP Mode**:
1. Changes written to memory.json
2. Embeddings generated using OpenAI
3. Vectors stored in Qdrant
4. Both storage systems remain consistent

### Search Process

When searching:
1. Query text is converted to embedding
2. Qdrant performs similarity search
3. Results include both entities and relations
4. Results are ranked by semantic similarity

## Observations Array Format

**Entity Storage Structure:**
```typescript
interface Entity {
  name: string;
  entityType: string; 
  observations: string[];  // Array of observation strings
}

// Example in Qdrant payload:
{
  type: "chunk",
  chunk_type: "metadata",
  entity_name: "AuthService",
  entity_type: "class", 
  observations: [
    "Handles user authentication",
    "Manages JWT tokens",
    "Integrates with OAuth providers"
  ],
  content: "Handles user authentication. Manages JWT tokens. Integrates with OAuth providers"
}
```

**Usage in All Modes:**
- **search_similar**: Returns `observations` field in results
- **read_graph (entities/raw)**: Shows full `observations` array
- **read_graph (smart)**: Includes observations in API surface functions/classes

## Example Usage

```typescript
// Entity-specific graph filtering (NEW v2.7)
const entityGraph = await client.callTool("read_graph", {
  entity: "AuthService",      // Focus on specific entity
  mode: "smart"              // AI summary of connections
});
// Returns: AI-powered summary with connection stats and relationship breakdown

// Debug specific function relationships
const relationshipGraph = await client.callTool("read_graph", {
  entity: "process_login",
  mode: "relationships"      // Only relations involving entity
});
// Returns: 10-20 focused relations instead of 300+ scattered ones

// Find entities connected to specific component
const connectionGraph = await client.callTool("read_graph", {
  entity: "validate_token",
  mode: "entities"          // Connected entities only
});

// General graph views (backward compatible)
const smartGraph = await client.callTool("read_graph", {
  mode: "smart",           // AI-optimized view (default)
  limit: 20               // Max entities per type
});

// Entity type filtering
const classes = await client.callTool("read_graph", {
  mode: "entities",
  entityTypes: ["class", "function"],
  limit: 10
});

// Unified entityTypes filtering - entity types only
const entityResults = await client.callTool("search_similar", {
  query: "development tasks",
  entityTypes: ["function", "class"], // Filter by specific entity types
  limit: 5
});

// Unified entityTypes filtering - chunk types only  
const metadataResults = await client.callTool("search_similar", {
  query: "authentication",
  entityTypes: ["metadata"], // Fast metadata-only search
  limit: 10
});

// Unified entityTypes filtering - mixed types (OR logic)
const mixedResults = await client.callTool("search_similar", {
  query: "authentication",
  entityTypes: ["function", "metadata", "implementation"], // Returns functions OR metadata OR implementation chunks
  limit: 10
});

// Search without filtering (returns all entity and chunk types)
const allResults = await client.callTool("search_similar", {
  query: "authentication",
  limit: 10
});
```

### 🎯 Smart Mode Features

The enhanced `read_graph` with `mode: "smart"` provides:

```typescript
interface SmartGraphResponse {
  summary: {
    totalEntities: number;
    totalRelations: number;
    breakdown: Record<string, number>; // Entity type counts
    keyModules: string[];              // Top-level packages/modules
    timestamp: string;
  };
  apiSurface: {
    classes: Array<{
      name: string;
      file: string;
      line: number;
      docstring?: string;
      methods: string[];
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
    external: string[];                // External packages
    internal: Array<{from: string, to: string}>; // Key internal deps
  };
  relations: {
    inheritance: Array<{from: string, to: string}>;
    keyUsages: Array<{from: string, to: string, type: string}>;
  };
}
```

**Benefits:**
- ✅ **Token Compliant**: Always <25k tokens (vs 393k raw)
- ✅ **Prioritized Content**: Public APIs and documented code first  
- ✅ **Structured Insights**: Summary, dependencies, relationships
- ✅ **Performance**: Sub-second response times with large collections

## HTTPS and Reverse Proxy Configuration

The server supports connecting to Qdrant through HTTPS and reverse proxies. This is particularly useful when:
- Running Qdrant behind a reverse proxy like Nginx or Apache
- Using self-signed certificates
- Requiring custom SSL/TLS configurations

### Setting up with a Reverse Proxy

1. Configure your reverse proxy (example using Nginx):
```nginx
server {
    listen 443 ssl;
    server_name qdrant.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:6333;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

2. Update your environment variables:
```bash
QDRANT_URL=https://qdrant.yourdomain.com
```

### Security Considerations

The server implements robust HTTPS handling with:
- Custom SSL/TLS configuration
- Proper certificate verification options
- Connection pooling and keepalive
- Automatic retry with exponential backoff
- Configurable timeouts

### Troubleshooting HTTPS Connections

If you experience connection issues:

1. Verify your certificates:
```bash
openssl s_client -connect qdrant.yourdomain.com:443
```

2. Test direct connectivity:
```bash
curl -v https://qdrant.yourdomain.com/collections
```

3. Check for any proxy settings:
```bash
env | grep -i proxy
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT